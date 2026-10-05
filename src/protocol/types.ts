export type ScalarType = 'u8' | 'u16' | 'i16' | 'u32' | 'i32' | 'bitset32' | 'bitset64'

export interface BitFieldDefinition {
  bit?: number
  mask?: number
}

export interface ProtocolFieldDefinition {
  key: string
  offset: string
  type: ScalarType
  scale?: number
  repeat?: string
  stride?: number
  optional?: boolean
  enum?: string
  bitIndexBase?: number
  bitFields?: Record<string, BitFieldDefinition>
}

export interface ProtocolProfile {
  id: string
  name: string
  frame: {
    header: number[]
    tail: number[]
    function: number
    lengthOffset: number
    payloadOffset: number
    checksum: 'crc16-modbus-le'
  }
  request: number[]
  variables: Record<string, string>
  fields: ProtocolFieldDefinition[]
}

export type ProtocolValue = number | number[] | boolean
export type ProtocolValues = Record<string, ProtocolValue | undefined>

export interface DecodeResult {
  values: ProtocolValues
  unavailable: string[]
}

export type FrameParseResult =
  | { ok: true; payload: Uint8Array }
  | { ok: false; error: string }
