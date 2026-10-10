import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

/**
 * The interruptions on each paired server this desktop has already decided about: announced in a
 * toast, resumed without asking, or shown in the dialog. Offers are born only at a server teardown,
 * so a chat and the moment it was cut off name one interruption exactly, and a reconnect, a reload
 * or a reopened window decides nothing twice.
 *
 * This run's record in memory is the authority; the window's storage only seeds it at startup and
 * carries it to the next launch. It is presentation only — the server holds the offers — so a
 * storage that refuses writes costs at most one repeated notice per launch, never a second
 * decision within a run. Every successful read prunes it to what the server still offers, and a
 * removed or re-paired server's entry goes, so it can never grow.
 */

const STORAGE_KEY = 'orca.nativeChatRestartDecided.v1'

type DecidedByEnvironment = Record<string, string[]>

export function restartInterruptionKey(
  candidate: Pick<ResumeCandidate, 'sessionId' | 'recordedAt'>
): string {
  return `${candidate.sessionId}\u0000${candidate.recordedAt}`
}

function read(): DecidedByEnvironment {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([environmentId, keys]) =>
        Array.isArray(keys)
          ? [[environmentId, keys.filter((key): key is string => typeof key === 'string')]]
          : []
      )
    )
  } catch {
    return {}
  }
}

function write(next: DecidedByEnvironment): void {
  try {
    if (Object.keys(next).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY)
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
  } catch {
    // Storage refused: the next read may announce again, which is all this costs.
  }
}

/** This run's record per server, seeded from storage on first use. */
const memory = new Map<string, Set<string>>()

function keysFor(environmentId: string): Set<string> {
  let keys = memory.get(environmentId)
  if (!keys) {
    keys = new Set(read()[environmentId] ?? [])
    memory.set(environmentId, keys)
  }
  return keys
}

function persist(environmentId: string, keys: ReadonlySet<string>): void {
  const all = read()
  if (keys.size === 0) {
    delete all[environmentId]
  } else {
    all[environmentId] = [...keys]
  }
  write(all)
}

export function decidedRestartInterruptions(environmentId: string): ReadonlySet<string> {
  return new Set(keysFor(environmentId))
}

/** Marks these decided, and drops every key the server no longer offers. */
export function settleRestartInterruptions(
  environmentId: string,
  offered: readonly string[],
  decided: readonly string[]
): void {
  const stillOffered = new Set(offered)
  const keys = new Set(
    [...keysFor(environmentId), ...decided].filter((key) => stillOffered.has(key))
  )
  memory.set(environmentId, keys)
  persist(environmentId, keys)
}

/** Every server with a record, so a removed one's can be forgotten. */
export function restartDecidedEnvironments(): string[] {
  const remembered = [...memory].flatMap(([environmentId, keys]) =>
    keys.size > 0 ? [environmentId] : []
  )
  return [...new Set([...Object.keys(read()), ...remembered])]
}

export function forgetRestartInterruptions(environmentId: string): void {
  // Empty rather than absent, so storage that refused the delete cannot seed the old keys back.
  memory.set(environmentId, new Set())
  persist(environmentId, new Set())
}

/** @internal - a new window starts with only what storage carried over. */
export function _resetRestartDecidedMemory(): void {
  memory.clear()
}
