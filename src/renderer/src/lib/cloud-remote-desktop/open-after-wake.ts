import type { CloudRemoteDesktopResult } from '../../../../shared/hosted-sandbox/cloud-remote-desktop'
import type { CloudRemoteDesktopToastFailure } from '@/components/cloud-remote-desktop/CloudRemoteDesktopToast'

/** Between desktop attempts while a just-woken sandbox finishes starting (orcad, the forward). */
export const AFTER_WAKE_RETRY_MS = 2_000
/** How long a just-woken sandbox gets to answer with a desktop before the failure shows. */
export const AFTER_WAKE_DEADLINE_MS = 60_000
/** A sandbox still asleep this many answers after a wake did not wake. */
const ASLEEP_ANSWERS_BEFORE_FAILING = 2

export type OpenAfterWakeOutcome =
  | { kind: 'opened'; environmentId: string; url: string }
  | { kind: 'failed'; code: CloudRemoteDesktopToastFailure }
  /** The wake flow reported its own failure (Unarchive's toast), or the workspace went away. */
  | { kind: 'cancelled' }

export type OpenAfterWakeDeps = {
  /** Wakes the sandbox (or unarchives, then wakes); false when that flow already said why not. */
  wake: () => Promise<boolean>
  /** Whether a wake that began at or after `startedAt` reported failure. */
  wakeFailedSince: (startedAt: number) => boolean
  /** Re-read after the wake: the workspace may have been deleted meanwhile. */
  environmentId: () => string | null
  open: (environmentId: string) => Promise<CloudRemoteDesktopResult>
  /** The sandbox is awake: the desktop is starting now. */
  onAwake: () => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * "Wake sandbox" / "Unarchive" from the desktop toast: wake, then open the desktop without a
 * second click. A just-woken sandbox can briefly answer "starting" (or the forward can lag the
 * paired connection), so those retry until the deadline; anything else is the answer.
 */
export async function openDesktopAfterWake(deps: OpenAfterWakeDeps): Promise<OpenAfterWakeOutcome> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const startedAt = now()
  if (!(await deps.wake())) {
    return { kind: 'cancelled' }
  }
  if (deps.wakeFailedSince(startedAt)) {
    return { kind: 'failed', code: 'wake_failed' }
  }
  deps.onAwake()
  const deadline = now() + AFTER_WAKE_DEADLINE_MS
  let asleepAnswers = 0
  for (;;) {
    const environmentId = deps.environmentId()
    if (!environmentId) {
      return { kind: 'cancelled' }
    }
    const result = await deps.open(environmentId)
    if (result.ok) {
      return { kind: 'opened', environmentId, url: result.url }
    }
    if (result.code === 'not_running') {
      asleepAnswers += 1
      if (asleepAnswers >= ASLEEP_ANSWERS_BEFORE_FAILING) {
        return { kind: 'failed', code: 'wake_failed' }
      }
    } else if (result.code !== 'starting' && result.code !== 'forward_failed') {
      return { kind: 'failed', code: result.code }
    }
    if (now() + AFTER_WAKE_RETRY_MS > deadline) {
      return { kind: 'failed', code: result.code === 'not_running' ? 'wake_failed' : result.code }
    }
    await sleep(AFTER_WAKE_RETRY_MS)
  }
}
