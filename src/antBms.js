const SERVICES = [
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
]

const CHANNEL_PAIRS = [['ffe1', 'ffe1'], ['fff3', 'fff4'], ['fff5', 'fff6']]

export const STATUS_NAMES = ['未知', '静置', '充电', '放电', '待机', '故障']

function crc16(bytes) {
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

const uint16 = (data, offset) => data[offset] | (data[offset + 1] << 8)
const int16 = (data, offset) => {
  const value = uint16(data, offset)
  return value > 0x7fff ? value - 0x10000 : value
}
const uint32 = (data, offset) => (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0

export function parseStatus(payload) {
  const sensorCount = payload[2]
  const cellCount = payload[3]
  let offset = 28 + cellCount * 2 + sensorCount * 2
  if (payload.length < offset + 24) throw new Error('状态帧长度不足')
  offset += 4 // MOS 和均衡温度
  const voltage = uint16(payload, offset) / 100
  const current = int16(payload, offset + 2) / 10
  const soc = uint16(payload, offset + 4)
  offset += 8 // 总压、电流、SOC、SOH
  const chargeMos = payload[offset]
  const dischargeMos = payload[offset + 1]
  const bmsType = payload[offset + 3]
  offset += 4 // MOS、均衡状态、BMS 类型

  return {
    soc,
    voltage,
    current,
    cellCount,
    sensorCount,
    state: STATUS_NAMES[payload[1]] ?? `状态 ${payload[1]}`,
    remainingAh: uint32(payload, offset + 4) / 1e6,
    totalAh: uint32(payload, offset) / 1e6,
    chargeMos,
    dischargeMos,
    bmsType,
  }
}

function suffix(characteristic) {
  return characteristic.uuid.replaceAll('-', '').slice(4, 8).toLowerCase()
}

export class AntBmsConnection {
  constructor(onStatus) {
    this.onStatus = onStatus
    this.buffer = new Uint8Array()
    this.poller = null
  }

  async connect() {
    if (!navigator.bluetooth) throw new Error('此浏览器不支持 Web Bluetooth；请使用 Chrome 或 Edge。')
    this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES })
    this.device.addEventListener('gattserverdisconnected', this.onDisconnected)
    const server = await this.device.gatt.connect()
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

  async findChannel(server) {
    const characteristics = []
    for (const serviceId of SERVICES) {
      try {
        const service = await server.getPrimaryService(serviceId)
        characteristics.push(...await service.getCharacteristics())
      } catch { /* 服务不存在时继续尝试 */ }
    }
    if (!characteristics.length) throw new Error('未发现 ANT 串口服务（FFE0 / FFF0）。')
    const bySuffix = (value) => characteristics.find((item) => suffix(item) === value)
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

  onNotification = (event) => {
    const incoming = new Uint8Array(event.target.value.buffer)
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

  onDisconnected = () => this.close()

  async poll() {
    if (!this.writeCharacteristic) return
    const frame = createReadStatusFrame()
    if (this.writeCharacteristic.properties.write) await this.writeCharacteristic.writeValueWithResponse(frame)
    else await this.writeCharacteristic.writeValueWithoutResponse(frame)
  }

  close() {
    window.clearInterval(this.poller)
    this.poller = null
    this.buffer = new Uint8Array()
    this.notifyCharacteristic?.removeEventListener('characteristicvaluechanged', this.onNotification)
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected)
    if (this.device?.gatt?.connected) this.device.gatt.disconnect()
    this.writeCharacteristic = null
    this.notifyCharacteristic = null
  }
}
