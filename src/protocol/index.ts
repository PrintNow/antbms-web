import enumData from './ant-bms.enums.json'
import profileData from './ant-bms.realtime.v1.json'
import { decodePayload, parseFrame } from './interpreter'
import type { ProtocolProfile } from './types'

export * from './interpreter'
export * from './types'

export const antBmsRealtimeProfile = profileData as ProtocolProfile
export const antBmsEnums = enumData as Record<string, Record<string, string>>

export function parseAntBmsRealtimeFrame(frame: Uint8Array) {
  const parsed = parseFrame(antBmsRealtimeProfile, frame)
  return parsed.ok ? { ...parsed, ...decodePayload(antBmsRealtimeProfile, parsed.payload) } : parsed
}

export function enumLabel(group: string, value: number | undefined): string {
  if (value === undefined) return '—'
  return antBmsEnums[group]?.[String(value)] ?? `状态 ${value}`
}
