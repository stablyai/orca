import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../shared/structured-agent-session-reducer'
import type { StructuredAgentSessionReadSnapshot } from './structured-agent-session-read-owner-contract'

const IDLE_TTL_MS = 300_000
const MAX_RECORDS = 8
const MAX_ITEMS = 5_000
const MAX_RECORD_BYTES = 8 * 1024 * 1024
const MAX_BYTES = 16 * 1024 * 1024
const records = new Map<
  string,
  { snapshot: StructuredAgentSessionReadSnapshot; bytes: number; expires: number }
>()
let timer: ReturnType<typeof setTimeout> | undefined
const encoder = new TextEncoder()

function payloadBytes(value: unknown, remaining: number): number {
  if (value === undefined) {
    return 0
  }
  if (value === null || typeof value !== 'object') {
    return encoder.encode(JSON.stringify(value)).byteLength
  }
  let bytes = 2
  const entries = Array.isArray(value) ? value.map((entry) => ['', entry]) : Object.entries(value)
  for (const [key, entry] of entries) {
    if (entry === undefined) {
      continue
    }
    if (!Array.isArray(value)) {
      bytes += encoder.encode(JSON.stringify(key)).byteLength + 1
    }
    bytes += payloadBytes(entry, remaining - bytes) + 1
    if (bytes > remaining) {
      break
    }
  }
  return bytes
}
function schedule(): void {
  clearTimeout(timer)
  const now = Date.now()
  for (const [key, record] of records) {
    if (record.expires <= now) {
      records.delete(key)
    }
  }
  const next = Math.min(...[...records.values()].map((record) => record.expires))
  if (Number.isFinite(next)) {
    timer = setTimeout(schedule, Math.max(1, next - now))
  }
}
export function forgetStructuredReadResume(key: string): void {
  records.delete(key)
  schedule()
}
export function takeStructuredReadResume(
  key: string
): StructuredAgentSessionReadSnapshot | undefined {
  const record = records.get(key)
  forgetStructuredReadResume(key)
  return record && record.expires > Date.now() ? record.snapshot : undefined
}
export function retainStructuredReadResume(
  key: string,
  snapshot: StructuredAgentSessionReadSnapshot
): void {
  records.delete(key)
  if (snapshot.state.epoch === null || snapshot.state.items.length > MAX_ITEMS) {
    schedule()
    return
  }
  const retained = { ...snapshot, current: false, loadingOlder: false }
  const bytes = payloadBytes(retained, MAX_RECORD_BYTES)
  if (bytes <= MAX_RECORD_BYTES) {
    records.set(key, { snapshot: retained, bytes, expires: Date.now() + IDLE_TTL_MS })
  }
  let total = [...records.values()].reduce((sum, record) => sum + record.bytes, 0)
  for (const [oldest, record] of records) {
    if (records.size <= MAX_RECORDS && total <= MAX_BYTES) {
      break
    }
    records.delete(oldest)
    total -= record.bytes
  }
  schedule()
}
export function clearStructuredReadResumeCache(): void {
  records.clear()
  clearTimeout(timer)
}
export function initialStructuredReadSnapshot(key: string): StructuredAgentSessionReadSnapshot {
  return (
    takeStructuredReadResume(key) ?? {
      state: EMPTY_STRUCTURED_AGENT_SESSION,
      loadingOlder: false,
      olderHistoryGeneration: 0,
      current: false
    }
  )
}
