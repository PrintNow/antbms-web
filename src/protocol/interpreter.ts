import type { DecodeResult, FrameParseResult, ProtocolFieldDefinition, ProtocolProfile, ProtocolValue, ProtocolValues, ScalarType } from './types'

const byteWidth: Record<ScalarType, number> = { u8: 1, u16: 2, i16: 2, u32: 4, i32: 4, bitset32: 4, bitset64: 8 }

export function crc16Modbus(bytes: Uint8Array): number {
  let crc = 0xffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
  }
  return crc
}

function readNumber(data: Uint8Array, offset: number, type: ScalarType): number | number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (type === 'u8') return view.getUint8(offset)
  if (type === 'u16') return view.getUint16(offset, true)
  if (type === 'i16') return view.getInt16(offset, true)
  if (type === 'u32') return view.getUint32(offset, true)
  if (type === 'i32') return view.getInt32(offset, true)
  const width = byteWidth[type]
  const bits: number[] = []
  for (let byte = 0; byte < width; byte += 1) {
    const value = data[offset + byte]
    for (let bit = 0; bit < 8; bit += 1) if (value & (1 << bit)) bits.push(byte * 8 + bit + 1)
  }
  return bits
}

function tokenize(expression: string): string[] {
  const tokens = expression.match(/\$?[A-Za-z_][A-Za-z0-9_]*|\d+|[+*()]/g) ?? []
  if (tokens.join('') !== expression.replace(/\s/g, '')) throw new Error(`不支持的 DSL 表达式：${expression}`)
  return tokens
}

function evaluateExpression(expression: string, context: Record<string, number>): number {
  const tokens = tokenize(expression)
  let cursor = 0
  const factor = (): number => {
    const token = tokens[cursor++]
    if (token === '(') {
      const value = add()
      if (tokens[cursor++] !== ')') throw new Error(`DSL 表达式括号未闭合：${expression}`)
      return value
    }
    if (/^\d+$/.test(token ?? '')) return Number(token)
    if (token?.startsWith('$') && Number.isFinite(context[token.slice(1)])) return context[token.slice(1)]
    throw new Error(`DSL 表达式变量不存在：${token ?? '结束'}`)
  }
  const multiply = (): number => {
    let value = factor()
    while (tokens[cursor] === '*') { cursor += 1; value *= factor() }
    return value
  }
  const add = (): number => {
    let value = multiply()
    while (tokens[cursor] === '+') { cursor += 1; value += multiply() }
    return value
  }
  const value = add()
  if (cursor !== tokens.length) throw new Error(`DSL 表达式无法完整解析：${expression}`)
  return value
}

function scalar(data: Uint8Array, field: ProtocolFieldDefinition, offset: number): ProtocolValue {
  const raw = readNumber(data, offset, field.type)
  if (Array.isArray(raw)) return raw.map((value) => value + (field.bitIndexBase ?? 1) - 1)
  return field.scale ? raw * field.scale : raw
}

function decodeField(data: Uint8Array, field: ProtocolFieldDefinition, context: Record<string, number>): ProtocolValue | undefined {
  const offset = evaluateExpression(field.offset, context)
  const repeat = field.repeat ? evaluateExpression(field.repeat, context) : 1
  const stride = field.stride ?? byteWidth[field.type]
  const width = byteWidth[field.type]
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(repeat) || repeat < 0 || offset + Math.max(0, repeat - 1) * stride + width > data.length) return undefined
  if (repeat === 1 && !field.repeat) return scalar(data, field, offset)
  return Array.from({ length: repeat }, (_, index) => scalar(data, field, offset + index * stride) as number)
}

export function decodePayload(profile: ProtocolProfile, payload: Uint8Array): DecodeResult {
  const values: ProtocolValues = {}
  const context: Record<string, number> = { payloadLength: payload.length }
  const unavailable: string[] = []
  for (const field of profile.fields) {
    const value = decodeField(payload, field, context)
    if (value === undefined) { unavailable.push(field.key); continue }
    values[field.key] = value
    if (typeof value === 'number') context[field.key] = value
    for (const [name, expression] of Object.entries(profile.variables)) {
      try { context[name] = evaluateExpression(expression, context) } catch { /* 依赖字段尚未准备好 */ }
    }
    if (typeof value === 'number' && field.bitFields) {
      for (const [name, bitField] of Object.entries(field.bitFields)) {
        if (bitField.bit !== undefined) values[name] = Boolean(value & (1 << bitField.bit))
        if (bitField.mask !== undefined) values[name] = value & bitField.mask
      }
    }
  }
  return { values, unavailable }
}

export function parseFrame(profile: ProtocolProfile, frame: Uint8Array): FrameParseResult {
  const { header, tail, lengthOffset, payloadOffset, function: functionCode } = profile.frame
  if (frame.length < payloadOffset + 4) return { ok: false, error: '帧长度不足' }
  if (!header.every((value, index) => frame[index] === value)) return { ok: false, error: '帧头不匹配' }
  if (frame[2] !== functionCode) return { ok: false, error: '功能码不匹配' }
  const payloadLength = frame[lengthOffset]
  const expectedLength = payloadOffset + payloadLength + 4
  if (frame.length !== expectedLength) return { ok: false, error: '帧长度与长度字段不一致' }
  if (!tail.every((value, index) => frame[frame.length - tail.length + index] === value)) return { ok: false, error: '帧尾不匹配' }
  const expectedCrc = crc16Modbus(frame.slice(1, payloadOffset + payloadLength))
  const actualCrc = frame[payloadOffset + payloadLength] | (frame[payloadOffset + payloadLength + 1] << 8)
  if (expectedCrc !== actualCrc) return { ok: false, error: 'CRC 校验失败' }
  return { ok: true, payload: frame.slice(payloadOffset, payloadOffset + payloadLength) }
}

export function formatMinutes(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value === 0xffff) return undefined
  return `${Math.floor(value / 60)} 小时 ${value % 60} 分钟`
}
