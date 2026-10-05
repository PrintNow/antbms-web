import { antBmsRealtimeProfile, decodePayload, enumLabel, parseAntBmsRealtimeFrame, type ProtocolValues } from './protocol'

const SERVICES = [
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
]

const CHANNEL_PAIRS = [['ffe1', 'ffe1'], ['fff3', 'fff4'], ['fff5', 'fff6']]

export interface BmsStatus {
  soc: number
  soh: number
  voltage: number
  current: number
  power: number
  cellCount: number
  sensorCount: number
  cellVoltages: number[]
  cellHigh: number | null
  cellLow: number | null
  cellAverage: number | null
  cellDifference: number | null
  temperatures: number[]
  mosTemperature: number
  balanceTemperature: number
  state: string
  permissions: number
  protectionBits: number[]
  warningBits: number[]
  remainingAh: number
  totalAh: number
  totalCycleAh: number
  runtimeSeconds: number
  balanceBits: number[]
  chargeMos: number
  dischargeMos: number
  balanceState: number
  bmsType: number
  chargeRemainingMinutes?: number
  dischargeRemainingMinutes?: number
  chargerOnline?: boolean
  chargerState?: number
  chargerOutputVoltage?: number
  chargerOutputCurrent?: number
}

export interface ConnectionInfo {
  deviceName: string
  channel: string
}

export function createReadStatusFrame() {
  return new Uint8Array(antBmsRealtimeProfile.request)
}

const number = (values: ProtocolValues, key: string): number => typeof values[key] === 'number' ? values[key] as number : 0
const numbers = (values: ProtocolValues, key: string): number[] => Array.isArray(values[key]) ? values[key] as number[] : []
const optionalNumber = (values: ProtocolValues, key: string): number | undefined => typeof values[key] === 'number' ? values[key] as number : undefined

export function parseStatus(payload: Uint8Array): BmsStatus {
  return statusFromValues(decodePayload(antBmsRealtimeProfile, payload).values)
}

export function statusFromValues(values: ProtocolValues): BmsStatus {
  const cellVoltages = numbers(values, 'cellVoltages')
  const cellHigh = cellVoltages.length ? Math.max(...cellVoltages) : null
  const cellLow = cellVoltages.length ? Math.min(...cellVoltages) : null
  const chargerOnline = values.chargerOnline === true ? true : values.chargerOnline === false ? false : undefined
  return {
    soc: number(values, 'soc'), soh: number(values, 'soh'), voltage: number(values, 'voltage'), current: number(values, 'current'), power: number(values, 'power'),
    cellCount: number(values, 'cellCount'), sensorCount: number(values, 'temperatureCount'), cellVoltages, cellHigh, cellLow,
    cellAverage: cellVoltages.length ? cellVoltages.reduce((sum, value) => sum + value, 0) / cellVoltages.length : null,
    cellDifference: cellHigh !== null && cellLow !== null ? cellHigh - cellLow : null,
    temperatures: numbers(values, 'temperatures'), mosTemperature: number(values, 'mosTemperature'), balanceTemperature: number(values, 'balanceTemperature'),
    state: enumLabel('batteryState', optionalNumber(values, 'batteryStateCode')), permissions: number(values, 'permissions'),
    protectionBits: numbers(values, 'protectionBits'), warningBits: numbers(values, 'warningBits'), remainingAh: number(values, 'remainingAh'), totalAh: number(values, 'totalAh'),
    totalCycleAh: number(values, 'totalCycleAh'), runtimeSeconds: number(values, 'runtimeSeconds'), balanceBits: numbers(values, 'balanceBits'),
    chargeMos: number(values, 'chargeMos'), dischargeMos: number(values, 'dischargeMos'), balanceState: number(values, 'balanceState'), bmsType: number(values, 'bmsType'),
    chargeRemainingMinutes: optionalNumber(values, 'chargeRemainingMinutes'), dischargeRemainingMinutes: optionalNumber(values, 'dischargeRemainingMinutes'),
    chargerOnline, chargerState: optionalNumber(values, 'chargerState'), chargerOutputVoltage: optionalNumber(values, 'chargerOutputVoltage'), chargerOutputCurrent: optionalNumber(values, 'chargerOutputCurrent'),
  }
}

function suffix(characteristic: BluetoothRemoteGATTCharacteristic): string {
  return characteristic.uuid.replaceAll('-', '').slice(4, 8).toLowerCase()
}

export class AntBmsConnection {
  private readonly onStatus: (status: BmsStatus) => void
  private buffer = new Uint8Array()
  private poller?: number
  private pollingInterval?: number
  private device?: BluetoothDevice
  private writeCharacteristic?: BluetoothRemoteGATTCharacteristic
  private notifyCharacteristic?: BluetoothRemoteGATTCharacteristic
  channel?: string

  constructor(onStatus: (status: BmsStatus) => void) {
    this.onStatus = onStatus
  }

  async connect(): Promise<ConnectionInfo> {
    if (!navigator.bluetooth) throw new Error('此浏览器不支持 Web Bluetooth；请使用 Chrome 或 Edge。')
    this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES })
    this.device.addEventListener('gattserverdisconnected', this.onDisconnected)
    const gatt = this.device.gatt
    if (!gatt) throw new Error('该蓝牙设备未提供 GATT 服务。')
    const server = await gatt.connect()
    const [writeCharacteristic, notifyCharacteristic, channel] = await this.findChannel(server)
    this.writeCharacteristic = writeCharacteristic
    this.notifyCharacteristic = notifyCharacteristic
    this.channel = channel
    await notifyCharacteristic.startNotifications()
    notifyCharacteristic.addEventListener('characteristicvaluechanged', this.onNotification)
    await this.poll()
    this.startPolling(1000)
    return { deviceName: this.device.name || 'ANT BMS', channel }
  }

  private async findChannel(server: BluetoothRemoteGATTServer): Promise<[BluetoothRemoteGATTCharacteristic, BluetoothRemoteGATTCharacteristic, string]> {
    const characteristics: BluetoothRemoteGATTCharacteristic[] = []
    for (const serviceId of SERVICES) {
      try {
        const service = await server.getPrimaryService(serviceId)
        characteristics.push(...await service.getCharacteristics())
      } catch { /* 服务不存在时继续尝试 */ }
    }
    if (!characteristics.length) throw new Error('未发现 ANT 串口服务（FFE0 / FFF0）。')
    const bySuffix = (value: string) => characteristics.find((item) => suffix(item) === value)
    for (const [writeId, notifyId] of CHANNEL_PAIRS) {
      const write = bySuffix(writeId)
      const notify = bySuffix(notifyId)
      if (write && notify && (write.properties.write || write.properties.writeWithoutResponse) && (notify.properties.notify || notify.properties.indicate)) {
        return [write, notify, `${writeId.toUpperCase()} → ${notifyId.toUpperCase()}`]
      }
    }
    const write = characteristics.find((item) => item.properties.write || item.properties.writeWithoutResponse)
    const notify = characteristics.find((item) => item.properties.notify || item.properties.indicate)
    if (!write || !notify) throw new Error('找到服务，但没有可用的写入和通知特征。')
    return [write, notify, `${suffix(write).toUpperCase()} → ${suffix(notify).toUpperCase()}`]
  }

  private onNotification = (event: Event): void => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic
    const incoming = new Uint8Array(characteristic.value!.buffer)
    const joined = new Uint8Array(this.buffer.length + incoming.length)
    joined.set(this.buffer)
    joined.set(incoming, this.buffer.length)
    this.buffer = joined

    while (this.buffer.length > 0) {
      let start = -1
      for (let index = 0; index < this.buffer.length - 1; index += 1) {
        if (this.buffer[index] === 0x7e && this.buffer[index + 1] === 0xa1) { start = index; break }
      }
      if (start < 0) { this.buffer = this.buffer.slice(-1); return }
      this.buffer = this.buffer.slice(start)
      if (this.buffer.length < 6) return
      const frameLength = 10 + this.buffer[5]
      if (this.buffer.length < frameLength) return
      const frame = this.buffer.slice(0, frameLength)
      this.buffer = this.buffer.slice(frameLength)
      const parsed = parseAntBmsRealtimeFrame(frame)
      if (!parsed.ok) continue
      const status = statusFromValues(parsed.values)
      this.onStatus(status)
      this.startPolling(status.state === '充电' || status.state === '放电' ? 800 : 2000)
    }
  }

  private onDisconnected = (): void => this.close()

  private async poll(): Promise<void> {
    if (!this.writeCharacteristic) return
    const frame = createReadStatusFrame()
    if (this.writeCharacteristic.properties.write) await this.writeCharacteristic.writeValueWithResponse(frame)
    else await this.writeCharacteristic.writeValueWithoutResponse(frame)
  }

  private startPolling(interval: number): void {
    if (this.pollingInterval === interval && this.poller) return
    window.clearInterval(this.poller)
    this.pollingInterval = interval
    this.poller = window.setInterval(() => this.poll(), interval)
  }

  close(): void {
    window.clearInterval(this.poller)
    this.poller = undefined
    this.pollingInterval = undefined
    this.buffer = new Uint8Array()
    this.notifyCharacteristic?.removeEventListener('characteristicvaluechanged', this.onNotification)
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected)
    if (this.device?.gatt?.connected) this.device.gatt.disconnect()
    this.writeCharacteristic = undefined
    this.notifyCharacteristic = undefined
  }
}
