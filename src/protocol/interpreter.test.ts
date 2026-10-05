import { describe, expect, it } from 'vitest'
import { statusFromValues } from '../antBms'
import { antBmsRealtimeProfile, crc16Modbus, formatMinutes, parseAntBmsRealtimeFrame } from '.'

function writeU16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff
  data[offset + 1] = (value >>> 8) & 0xff
}

function writeI16(data: Uint8Array, offset: number, value: number): void {
  writeU16(data, offset, value & 0xffff)
}

function writeU32(data: Uint8Array, offset: number, value: number): void {
  for (let index = 0; index < 4; index += 1) data[offset + index] = (value >>> (index * 8)) & 0xff
}

function realtimeFrame(extended = true): Uint8Array {
  const cells = 2
  const temperatures = 1
  const dynamicLength = cells * 2 + temperatures * 2
  const payload = new Uint8Array(extended ? dynamicLength + 130 : dynamicLength + 114)
  payload[0] = 3
  payload[1] = 2
  payload[2] = temperatures
  payload[3] = cells
  writeU16(payload, 28, 3312)
  writeU16(payload, 30, 3318)
  writeI16(payload, 32, 26)
  writeI16(payload, dynamicLength + 28, 31)
  writeI16(payload, dynamicLength + 30, 30)
  writeU16(payload, dynamicLength + 32, 6630)
  writeI16(payload, dynamicLength + 34, -123)
  writeU16(payload, dynamicLength + 36, 80)
  writeU16(payload, dynamicLength + 38, 97)
  payload[dynamicLength + 40] = 1
  payload[dynamicLength + 41] = 1
  writeU32(payload, dynamicLength + 44, 280000000)
  writeU32(payload, dynamicLength + 48, 224500000)
  writeU32(payload, dynamicLength + 52, 123400)
  writeU32(payload, dynamicLength + 56, 456)
  writeU32(payload, dynamicLength + 60, 7200)
  if (extended) {
    writeU16(payload, dynamicLength + 114, 125)
    writeU16(payload, dynamicLength + 116, 380)
    writeU16(payload, dynamicLength + 124, 540)
    writeU16(payload, dynamicLength + 126, 87)
    writeU16(payload, dynamicLength + 128, 0x8007)
  }
  const frame = new Uint8Array(10 + payload.length)
  frame.set([0x7e, 0xa1, 0x11, 0, 0, payload.length])
  frame.set(payload, 6)
  const crc = crc16Modbus(frame.slice(1, 6 + payload.length))
  frame[6 + payload.length] = crc & 0xff
  frame[7 + payload.length] = crc >>> 8
  frame.set([0xaa, 0x55], 8 + payload.length)
  return frame
}

describe('ANT BMS 实时帧 DSL', () => {
  it('生成已验证的只读状态查询帧', () => {
    expect(antBmsRealtimeProfile.request).toEqual([0x7e, 0xa1, 0x01, 0, 0, 0xbe, 0x18, 0x55, 0xaa, 0x55])
  })

  it('解析带充电器扩展字段的状态帧与负电流', () => {
    const result = parseAntBmsRealtimeFrame(realtimeFrame())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = statusFromValues(result.values)
    expect(status.current).toBe(-12.3)
    expect(status.state).toBe('充电')
    expect(status.chargeRemainingMinutes).toBe(125)
    expect(status.chargerOnline).toBe(true)
    expect(status.chargerState).toBe(7)
    expect(status.chargerOutputVoltage).toBe(54)
    expect(status.chargerOutputCurrent).toBeCloseTo(8.7)
  })

  it('短实时帧保留核心数据并安全省略扩展字段', () => {
    const result = parseAntBmsRealtimeFrame(realtimeFrame(false))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = statusFromValues(result.values)
    expect(status.soc).toBe(80)
    expect(status.chargeRemainingMinutes).toBeUndefined()
    expect(status.chargerOnline).toBeUndefined()
  })

  it('拒绝 CRC 损坏帧', () => {
    const frame = realtimeFrame()
    frame[20] ^= 0xff
    expect(parseAntBmsRealtimeFrame(frame)).toMatchObject({ ok: false, error: 'CRC 校验失败' })
  })

  it('格式化有效充电剩余时间并拒绝保留值', () => {
    expect(formatMinutes(125)).toBe('2 小时 5 分钟')
    expect(formatMinutes(0xffff)).toBeUndefined()
  })
})
