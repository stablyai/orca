// Typing for a workspace whose server is being woken. Keys typed while the server boots are
// accepted at once, then sent, in order and exactly once, to the shell the pane is attached to
// after the wake, like terminal type-ahead: an Enter typed while waking runs the line once the
// shell is up. Only plain text, Tab and Enter are kept: Backspace and Ctrl-C edit the line not yet
// entered, and escape sequences and other control keys are dropped. Held typing is dropped when the wake fails, a while after it
// settles without a terminal to take it, and when the workspace wakes again.

import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { applyWakeInput } from './wake-input-text'
import { noteUserInputForPane, pruneUserInput, resetPaneUserInputForTests } from './pane-user-input'

export { WAKE_INPUT_CAP, applyWakeInput } from './wake-input-text'
export {
  noteUserInputForPane,
  paneHadUserInputSince,
  workspaceHadUserInputSince
} from './pane-user-input'
const FLUSH_POLL_MS = 100
/** A wake nobody settles stops holding typing after this, and the typing is dropped. */
export const WAKE_INPUT_MAX_HOLD_MS = 90_000
/** After the wake settles, a pane that never re-attaches loses its held typing after this. */
export const WAKE_INPUT_SETTLED_GRACE_MS = 15_000

type PaneBuffer = {
  /** Held keys in order; Enter is kept as `\r`. */
  text: string
  deliver: (data: string) => void
  isReady: () => boolean
  /** The pane's transport was seen not ready during the wake, so "ready" means re-attached. */
  sawUnready: boolean
}

type WorkspaceWake = {
  startedAt: number
  outcome: 'pending' | 'ready' | 'failed'
  settledAt: number | null
  panes: Map<string, PaneBuffer>
}

type WakeInputDelivery = { workspaceId: string; paneId: string }
/** Held typing that was not sent (wake failed, never re-attached). */
type WakeInputDropped = { workspaceId: string }

const wakes = new Map<string, WorkspaceWake>()
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  // Dev builds only: lets e2e drivers read what is held.
  Reflect.set(window, '__orcaWakeInput', wakes)
}
const listeners = new Set<() => void>()
const deliveryListeners = new Set<(delivery: WakeInputDelivery) => void>()
const droppedListeners = new Set<(dropped: WakeInputDropped) => void>()
// Runs only while a wake or held typing exists; paused while the window is hidden (no keys arrive then).
let stopTimer: (() => void) | null = null
let version = 0

function changed(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

function ensureTimer(): void {
  if (stopTimer) {
    return
  }
  // No pump on install or on becoming visible: callers are mid-update, the next tick delivers.
  stopTimer = installWindowVisibilityInterval({
    run: () => pump(),
    runOnVisible: () => {},
    intervalMs: FLUSH_POLL_MS
  })
}

function stopTimerIfIdle(): void {
  if (wakes.size === 0 && stopTimer) {
    stopTimer()
    stopTimer = null
  }
}

function hasHeldText(wake: WorkspaceWake): boolean {
  for (const pane of wake.panes.values()) {
    if (pane.text) {
      return true
    }
  }
  return false
}

/** Drops a workspace's held typing; tells the window when keys were actually lost. */
function discard(workspaceId: string, wake: WorkspaceWake, notify: boolean): void {
  const lost = notify && hasHeldText(wake)
  wakes.delete(workspaceId)
  pruneUserInput()
  if (lost) {
    for (const listener of droppedListeners) {
      listener({ workspaceId })
    }
  }
}

/** Inserts each pane's typing once its transport is attached to the woken terminal. */
function pump(now = Date.now()): void {
  let didChange = false
  for (const [workspaceId, wake] of wakes) {
    if (wake.outcome === 'pending' && now - wake.startedAt > WAKE_INPUT_MAX_HOLD_MS) {
      // Nobody settled this wake: whatever it attaches to now is unknown, so nothing is sent.
      discard(workspaceId, wake, true)
      didChange = true
      continue
    }
    if (wake.outcome === 'failed') {
      discard(workspaceId, wake, true)
      didChange = true
      continue
    }
    if (wake.settledAt !== null && now - wake.settledAt > WAKE_INPUT_SETTLED_GRACE_MS) {
      discard(workspaceId, wake, true)
      didChange = true
      continue
    }
    for (const [paneId, pane] of wake.panes) {
      if (!pane.text) {
        if (wake.outcome !== 'pending') {
          wake.panes.delete(paneId)
          didChange = true
        }
        continue
      }
      let ready = false
      try {
        ready = pane.isReady()
      } catch {
        ready = false
      }
      if (!ready) {
        pane.sawUnready = true
        continue
      }
      // A transport that never dropped during the wake may still be the old attachment; wait for
      // the wake itself to say the server answers.
      if (!pane.sawUnready && wake.outcome !== 'ready') {
        continue
      }
      const { text } = pane
      // Removed before sending: a pane is delivered to once, never twice.
      wake.panes.delete(paneId)
      didChange = true
      try {
        pane.deliver(text)
        noteUserInputForPane(paneId, now, workspaceId)
        for (const listener of deliveryListeners) {
          listener({ workspaceId, paneId })
        }
      } catch {
        // The pane went away mid-delivery; nothing to insert into.
      }
    }
    if (wake.outcome !== 'pending' && wake.panes.size === 0) {
      discard(workspaceId, wake, false)
      didChange = true
    }
  }
  if (didChange) {
    changed()
  }
  stopTimerIfIdle()
}

/** A wake of this workspace began (any source). Typing in its panes is held for the woken terminal. */
export function beginWorkspaceWake(workspaceId: string, startedAt: number): void {
  const current = wakes.get(workspaceId)
  if (current?.outcome === 'pending') {
    // The same wake reported again (renderer click, then main's events): keep what is held.
    current.startedAt = Math.min(current.startedAt, startedAt)
    return
  }
  // A settled wake's leftovers never carry into the next one.
  wakes.set(workspaceId, { startedAt, outcome: 'pending', settledAt: null, panes: new Map() })
  ensureTimer()
  changed()
}

/** The wake settled. `failed` drops held typing (the pane shows the failure instead). */
export function endWorkspaceWake(workspaceId: string, outcome: 'ready' | 'failed'): void {
  const wake = wakes.get(workspaceId)
  if (!wake || wake.outcome !== 'pending') {
    return
  }
  wake.outcome = outcome
  wake.settledAt = Date.now()
  changed()
  pump()
}

/** True while this workspace has a wake or held typing (cheap gate before anything else). */
export function hasWakeInput(workspaceId: string | null | undefined): boolean {
  return Boolean(workspaceId && wakes.has(workspaceId))
}

export function isWorkspaceWaking(workspaceId: string | null | undefined): boolean {
  return Boolean(workspaceId && wakes.get(workspaceId)?.outcome === 'pending')
}

/**
 * Holds `data` typed into a shell pane (`paneId` = its layout leaf) of a waking workspace, or
 * typed after the wake while earlier typing from the same pane still waits. Returns false when
 * nothing is held and the caller should forward as usual.
 */
export function captureWakeInput(
  workspaceId: string | null | undefined,
  paneId: string,
  data: string,
  deliver: (data: string) => void,
  isReady: () => boolean
): boolean {
  if (!workspaceId) {
    return false
  }
  const wake = wakes.get(workspaceId)
  const existing = wake?.panes.get(paneId)
  if (!wake || (wake.outcome !== 'pending' && !existing?.text)) {
    return false
  }
  const pane: PaneBuffer = existing ?? {
    text: '',
    deliver,
    isReady,
    sawUnready: false
  }
  pane.deliver = deliver
  pane.isReady = isReady
  pane.text = applyWakeInput(pane.text, data)
  wake.panes.set(paneId, pane)
  ensureTimer()
  changed()
  return true
}

/**
 * A pane remounted (a wake often replaces the pane's session): later deliveries for its held
 * typing go through the new session's forwarder.
 */
export function rebindWakeInputTarget(
  workspaceId: string | null | undefined,
  paneId: string,
  deliver: (data: string) => void,
  isReady: () => boolean
): void {
  const pane = workspaceId ? wakes.get(workspaceId)?.panes.get(paneId) : undefined
  if (pane) {
    pane.deliver = deliver
    pane.isReady = isReady
  }
}

/** "×" on the pending-typing chip. */
export function clearWakeInput(workspaceId: string): void {
  const wake = wakes.get(workspaceId)
  if (!wake) {
    return
  }
  wake.panes.clear()
  if (wake.outcome !== 'pending') {
    discard(workspaceId, wake, false)
    changed()
    return
  }
  changed()
}

/** How many characters are waiting for the woken terminal (the chip shows a count, never text). */
export function getWakeInputCount(workspaceId: string | null | undefined): number {
  const wake = workspaceId ? wakes.get(workspaceId) : undefined
  if (!wake) {
    return 0
  }
  let count = 0
  for (const pane of wake.panes.values()) {
    count += Array.from(pane.text).length
  }
  return count
}

export function subscribeWakeInput(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function subscribeWakeInputDelivered(
  listener: (delivery: WakeInputDelivery) => void
): () => void {
  deliveryListeners.add(listener)
  return () => deliveryListeners.delete(listener)
}

export function subscribeWakeInputDropped(
  listener: (dropped: WakeInputDropped) => void
): () => void {
  droppedListeners.add(listener)
  return () => droppedListeners.delete(listener)
}

export function getWakeInputVersion(): number {
  return version
}

/** Tests: drops every wake and stops the pump. */
export function resetWakeInputForTests(): void {
  wakes.clear()
  resetPaneUserInputForTests()
  stopTimer?.()
  stopTimer = null
  changed()
}

/** Tests: run one delivery pass now. */
export function pumpWakeInputForTests(now?: number): void {
  pump(now)
}
