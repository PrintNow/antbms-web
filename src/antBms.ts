const SERVICES = [
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
]

const CHANNEL_PAIRS = [['ffe1', 'ffe1'], ['fff3', 'fff4'], ['fff5', 'fff6']]

export const STATUS_NAMES = ['未知', '静置', '充电', '放电', '待机', '故障']

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
}

export interface ConnectionInfo {
  deviceName: string
  channel: string
}

function crc16(bytes: Uint8Array): number {
  let crc = 0xffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
  }
  return crc
}

export function createReadStatusFrame() {
  const head = new Uint8Array([0x7e, 0xa1, 0x01, 0x00, 0x00, 0xbe])
  const crc = crc16(head.slice(1))
  return new Uint8Array([...head, crc & 0xff, crc >> 8, 0xaa, 0x55])
}

const uint16 = (data: Uint8Array, offset: number): number => data[offset] | (data[offset + 1] << 8)
const int16 = (data: Uint8Array, offset: number): number => {
  const value = uint16(data, offset)
  return value > 0x7fff ? value - 0x10000 : value
}
const uint32 = (data: Uint8Array, offset: number): number => (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0
const int32 = (data: Uint8Array, offset: number): number => (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24))
const activeBits = (data: Uint8Array, offset: number): number[] => {
  const bits: number[] = []
  for (let byte = 0; byte < 8; byte += 1) {
    const value = data[offset + byte] ?? 0
    for (let bit = 0; bit < 8; bit += 1) if (value & (1 << bit)) bits.push(byte * 8 + bit + 1)
  }
  return bits
}

export function parseStatus(payload: Uint8Array): BmsStatus {
  const sensorCount = payload[2]
  const cellCount = payload[3]
  const cellOffset = 28
  const cellVoltages = Array.from({ length: cellCount }, (_, index) => uint16(payload, cellOffset + index * 2) / 1000)
  let offset = cellOffset + cellCount * 2
  const temperatures = Array.from({ length: sensorCount }, (_, index) => int16(payload, offset + index * 2))
  offset += sensorCount * 2
  if (payload.length < offset + 28) throw new Error('状态帧长度不足')
  const mosTemperature = int16(payload, offset)
  const balanceTemperature = int16(payload, offset + 2)
  offset += 4
  const voltage = uint16(payload, offset) / 100
  const current = int16(payload, offset + 2) / 10
  const soc = uint16(payload, offset + 4)
  const soh = uint16(payload, offset + 6)
  offset += 8
  const dischargeMos = payload[offset]
  const chargeMos = payload[offset + 1]
  const balanceState = payload[offset + 2]
  const bmsType = payload[offset + 3]
  offset += 4

  const totalAh = uint32(payload, offset) / 1e6
  const remainingAh = uint32(payload, offset + 4) / 1e6
  const totalCycleAh = uint32(payload, offset + 8) / 1e3
  const power = int32(payload, offset + 12)
  const runtimeSeconds = uint32(payload, offset + 16)
  const balanceBits = activeBits(payload, offset + 20)
  const cellHigh = cellVoltages.length ? Math.max(...cellVoltages) : null
  const cellLow = cellVoltages.length ? Math.min(...cellVoltages) : null
  const cellAverage = cellVoltages.length ? cellVoltages.reduce((sum, value) => sum + value, 0) / cellVoltages.length : null

  return {
    soc,
    voltage,
    current,
    cellCount,
    sensorCount,
    cellVoltages,
    cellHigh,
    cellLow,
    cellAverage,
    cellDifference: cellHigh !== null && cellLow !== null ? cellHigh - cellLow : null,
    temperatures,
    mosTemperature,
    balanceTemperature,
    soh,
    state: STATUS_NAMES[payload[1]] ?? `状态 ${payload[1]}`,
    permissions: payload[0],
    protectionBits: activeBits(payload, 4),
    warningBits: activeBits(payload, 12),
    remainingAh,
    totalAh,
    totalCycleAh,
    power,
    runtimeSeconds,
    balanceBits,
    chargeMos,
    dischargeMos,
    balanceState,
    bmsType,
  }
}

function suffix(characteristic: BluetoothRemoteGATTCharacteristic): string {
  return characteristic.uuid.replaceAll('-', '').slice(4, 8).toLowerCase()
}

export class AntBmsConnection {
  private readonly onStatus: (status: BmsStatus) => void
  private buffer = new Uint8Array()
  private poller?: number
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
    this.poller = window.setInterval(() => this.poll(), 2000)
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
      if (frame.at(-2) !== 0xaa || frame.at(-1) !== 0x55) continue
      const expected = crc16(frame.slice(1, 6 + frame[5]))
      const actual = frame[6 + frame[5]] | (frame[7 + frame[5]] << 8)
      if (expected !== actual || frame[2] !== 0x11) continue
      this.onStatus(parseStatus(frame.slice(6, 6 + frame[5])))
    }
  }

  private onDisconnected = (): void => this.close()

  private async poll(): Promise<void> {
    if (!this.writeCharacteristic) return
    const frame = createReadStatusFrame()
    if (this.writeCharacteristic.properties.write) await this.writeCharacteristic.writeValueWithResponse(frame)
    else await this.writeCharacteristic.writeValueWithoutResponse(frame)
  }

  close(): void {
    window.clearInterval(this.poller)
    this.poller = undefined
    this.buffer = new Uint8Array()
    this.notifyCharacteristic?.removeEventListener('characteristicvaluechanged', this.onNotification)
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected)
    if (this.device?.gatt?.connected) this.device.gatt.disconnect()
    this.writeCharacteristic = undefined
    this.notifyCharacteristic = undefined
  }
}
