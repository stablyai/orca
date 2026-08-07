import { prepareRendererForAppRestart } from '../../../shared/renderer-restart-preparation'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../../shared/renderer-shutdown-events'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT
} from '../../../shared/updater-renderer-events'

// Bare reloads are vetoed by dirty tabs; restart preparation backs them up first.

export type LazyChunkRecoveryReloadOutcome =
  /** Hot-exit backup or the session checkpoint refused; unsaved work stays put. */
  | 'checkpoint-refused'
  /** Something still vetoed beforeunload after the restart latch was armed. */
  | 'unload-vetoed'
  /** The reload was issued, but this document outlived the grace window. */
  | 'never-landed'
  /** The host rejected the reload request before navigation could begin. */
  | 'request-failed'

// Paired-web hosts may veto navigation without emitting the Electron signal.
const RELOAD_SETTLE_GRACE_MS = 10_000

type RefusedNavigationOutcome = 'unload-vetoed' | 'never-landed'
type ScheduleReloadGrace = (onElapsed: () => void) => () => void

type RefusedNavigationWait = {
  outcome: Promise<RefusedNavigationOutcome>
  cancel: () => void
}

const scheduleReloadGrace: ScheduleReloadGrace = (onElapsed) => {
  const timer = setTimeout(onElapsed, RELOAD_SETTLE_GRACE_MS)
  return () => clearTimeout(timer)
}

function waitForRefusedNavigation(
  win: Window,
  scheduleGrace: ScheduleReloadGrace
): RefusedNavigationWait {
  let cancelGrace = (): void => undefined
  let onUnloadPrevented: () => void = () => undefined
  const cancel = (): void => {
    cancelGrace()
    cancelGrace = () => undefined
    win.removeEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, onUnloadPrevented)
  }
  const outcome = new Promise<RefusedNavigationOutcome>((resolve) => {
    const settle = (result: RefusedNavigationOutcome): void => {
      cancel()
      resolve(result)
    }
    onUnloadPrevented = () => settle('unload-vetoed')
    win.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, onUnloadPrevented)
    cancelGrace = scheduleGrace(() => settle('never-landed'))
  })
  return { outcome, cancel }
}

/** Resolves only if the navigation is refused; a landed reload destroys this document. */
export async function requestLazyChunkRecoveryReload(
  win: Window,
  // Hosts without a preload bridge stage durably in-process; nothing to join.
  awaitCheckpoint: () => Promise<void> = () =>
    win.api?.app?.awaitBeforeUnloadCheckpoint?.() ?? Promise.resolve(),
  scheduleGrace: ScheduleReloadGrace = scheduleReloadGrace
): Promise<LazyChunkRecoveryReloadOutcome> {
  try {
    await prepareRendererForAppRestart(win, {
      startedEventName: ORCA_APP_RESTART_STARTED_EVENT,
      abortedEventName: ORCA_APP_RESTART_ABORTED_EVENT,
      awaitCheckpoint
    })
  } catch {
    // Never reload over editor buffers that could not be backed up.
    return 'checkpoint-refused'
  }

  let cancelRefusalWait = (): void => undefined
  let recoveryToken: string | null = null
  try {
    recoveryToken = (await win.api?.app?.beginLazyChunkRecoveryReload?.()) ?? null
    const refused = waitForRefusedNavigation(win, scheduleGrace)
    cancelRefusalWait = refused.cancel
    win.location.reload()
    return await refused.outcome
  } catch {
    return 'request-failed'
  } finally {
    cancelRefusalWait()
    if (recoveryToken !== null) {
      await win.api?.app?.cancelLazyChunkRecoveryReload?.(recoveryToken).catch(() => false)
    }
    // A surviving document must not retain the restart latch.
    win.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
  }
}
