import {
  DEADLINE_PASSED,
  createSettleNotifier,
  monotonicNow,
  type Settled
} from './deadline-settle-notifier'

type NamingPass = {
  claimedAtMs: number
  /** One reaction on the pass; waiters subscribe with their deadline and drop off when it lapses. */
  drained: (deadline: number) => Promise<Settled<unknown> | typeof DEADLINE_PASSED>
}

let namingInFlight: NamingPass | null = null
// A pass normally takes milliseconds; one held this long is stuck in an lstat/opendir, so callers use ps instead.
export const DARWIN_TERMINAL_NAMING_STALL_MS = 500

/** One /dev naming pass at a time: aborted lstat/opendir calls hold libuv pool threads until they drain. Null while one drains. */
export function claimDarwinTerminalNaming<T>(name: () => Promise<T>): Promise<T> | null {
  if (namingInFlight) {
    return null
  }
  const pending = name()
  const pass: NamingPass = { claimedAtMs: monotonicNow(), drained: createSettleNotifier(pending) }
  namingInFlight = pass
  const release = (): void => {
    if (namingInFlight === pass) {
      namingInFlight = null
    }
  }
  void pending.then(release, release)
  return pending
}

/** Wait for the in-flight pass to drain: 'stalled' once it has run past the stall threshold, so callers run ps. */
export async function waitForDarwinTerminalNaming(
  deadline: number
): Promise<'drained' | 'stalled' | typeof DEADLINE_PASSED> {
  const pass = namingInFlight
  if (!pass) {
    return 'drained'
  }
  const stallAt = pass.claimedAtMs + DARWIN_TERMINAL_NAMING_STALL_MS
  if (monotonicNow() >= stallAt) {
    return 'stalled'
  }
  if ((await pass.drained(Math.min(deadline, stallAt))) !== DEADLINE_PASSED) {
    return 'drained'
  }
  return monotonicNow() >= deadline ? DEADLINE_PASSED : 'stalled'
}

export function isDarwinTerminalNamingInFlight(): boolean {
  return namingInFlight !== null
}

export function resetDarwinTerminalNamingForTests(): void {
  namingInFlight = null
}
