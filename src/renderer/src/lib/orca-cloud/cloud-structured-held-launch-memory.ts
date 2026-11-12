// V3-01b: a held structured chat on Orca Cloud waits before its session is created, and that hold
// lives only in memory. A quit loses it: after a restart the chat's launch retries without knowing it
// was held, and the chat shows the generic sign-in notice. One record per held chat, per Orca
// profile on this device, puts the hold back. Never prompts, env or secrets.
import { useAppStore } from '@/store'

export type HeldStructuredLaunchRecord = {
  sessionId: string
  worktreeId: string
  environmentId: string
  agent: 'claude' | 'codex'
  createdAt: number
}

const KEY_PREFIX = 'orca.cloudHeldChats.v1'
const MAX_RECORDS = 50
/** A chat deleted while the app was closed never comes back; its record ages out. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function storage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

function storageKey(): string {
  return `${KEY_PREFIX}:${useAppStore.getState().activeOrcaProfileId ?? 'default'}`
}

function isRecord(value: unknown): value is HeldStructuredLaunchRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record: Partial<Record<keyof HeldStructuredLaunchRecord, unknown>> = value
  return (
    typeof record.sessionId === 'string' &&
    typeof record.worktreeId === 'string' &&
    typeof record.environmentId === 'string' &&
    (record.agent === 'claude' || record.agent === 'codex') &&
    typeof record.createdAt === 'number'
  )
}

function readAll(): HeldStructuredLaunchRecord[] {
  try {
    const raw = storage()?.getItem(storageKey())
    const parsed: unknown = raw ? JSON.parse(raw) : []
    const now = Date.now()
    return Array.isArray(parsed)
      ? parsed.filter(isRecord).filter((each) => now - each.createdAt < MAX_AGE_MS)
      : []
  } catch {
    return []
  }
}

function writeAll(records: HeldStructuredLaunchRecord[]): void {
  try {
    const kept = records.slice(-MAX_RECORDS)
    if (kept.length === 0) {
      storage()?.removeItem(storageKey())
    } else {
      storage()?.setItem(storageKey(), JSON.stringify(kept))
    }
  } catch {
    // Storage unavailable: the hold still works for this run.
  }
}

export function rememberHeldStructuredLaunch(record: HeldStructuredLaunchRecord): void {
  writeAll([...readAll().filter((each) => each.sessionId !== record.sessionId), record])
}

export function forgetHeldStructuredLaunch(sessionId: string): void {
  const records = readAll()
  const kept = records.filter((each) => each.sessionId !== sessionId)
  if (kept.length !== records.length) {
    writeAll(kept)
  }
}

export function readHeldStructuredLaunch(sessionId: string): HeldStructuredLaunchRecord | null {
  return readAll().find((each) => each.sessionId === sessionId) ?? null
}

export function readHeldStructuredLaunches(environmentId: string): HeldStructuredLaunchRecord[] {
  return readAll().filter((each) => each.environmentId === environmentId)
}
