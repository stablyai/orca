// Typing for a workspace whose server is being woken. Keys typed while the server boots are
// accepted at once, then inserted, in order and exactly once, into the shell the pane is attached
// to after the wake. They are never submitted: Enter is not replayed, so the person reviews what
// landed and presses Enter themselves. The woken terminal is a fresh process (whatever ran before
// the sleep is gone), so replaying a submitted line could run it somewhere it was not meant for.
// Only plain text is kept: Backspace edits the held text, Ctrl-C clears it, and escape sequences
// and other control keys are dropped. Held typing is dropped when the wake fails, a while after it
// settles without a terminal to take it, and when the workspace wakes again.

export const WAKE_INPUT_CAP = 4096
const FLUSH_POLL_MS = 100
/** A wake nobody settles stops holding typing after this, and the typing is dropped. */
export const WAKE_INPUT_MAX_HOLD_MS = 90_000
/** After the wake settles, a pane that never re-attaches loses its held typing after this. */
export const WAKE_INPUT_SETTLED_GRACE_MS = 15_000

type PaneBuffer = {
  text: string
  /** Enter was pressed: the person meant to submit; shown as "press Enter to run" after insertion. */
  submitted: boolean
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

export type WakeInputDelivery = { workspaceId: string; paneId: string; submitted: boolean }

const wakes = new Map<string, WorkspaceWake>()
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  // Dev builds only: lets e2e drivers read what is held.
  ;(window as unknown as { __orcaWakeInput?: unknown }).__orcaWakeInput = wakes
}
const listeners = new Set<() => void>()
const deliveryListeners = new Set<(delivery: WakeInputDelivery) => void>()
/** Panes whose typing was delivered after a wake (the continue logic leaves those alone). */
const typedPanes = new Map<string, number>()
let timer: ReturnType<typeof setInterval> | null = null
let version = 0

function changed(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

/**
 * Applies typed `data` to held `text`: printable characters append, Backspace removes one, Ctrl-C
 * clears, Enter/Tab are noted (Enter) or kept (Tab), everything else (escape sequences, other
 * controls) is dropped.
 */
export function applyWakeInput(
  held: { text: string; submitted: boolean },
  data: string
): { text: string; submitted: boolean } {
  let text = held.text
  let submitted = held.submitted
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!
    const code = ch.charCodeAt(0)
    if (code === 0x1b) {
      const next = data[i + 1]
      if (next === '[') {
        i += 2
        while (i < data.length && !/[\x40-\x7e]/.test(data[i]!)) {
          i++
        }
      } else if (next === ']') {
        // OSC: up to BEL or ST (ESC \).
        i += 2
        while (
          i < data.length &&
          data[i] !== '\x07' &&
          !(data[i] === '\x1b' && data[i + 1] === '\\')
        ) {
          i++
        }
        if (data[i] === '\x1b') {
          i++
        }
      } else if (next === 'O') {
        i += 2
      } else if (next !== undefined) {
        i += 1
      }
      continue
    }
    if (code === 0x03) {
      text = ''
      submitted = false
      continue
    }
    if (code === 0x7f || code === 0x08) {
      text = Array.from(text).slice(0, -1).join('')
      continue
    }
    if (code === 0x0d || code === 0x0a) {
      // Never replayed: the person submits after reviewing what landed.
      submitted = text.length > 0
      continue
    }
    if (code === 0x09) {
      text += ch
      continue
    }
    if (code < 0x20 || (code >= 0x80 && code < 0xa0)) {
      continue
    }
    text += ch
  }
  return { text: text.slice(0, WAKE_INPUT_CAP), submitted }
}

function ensureTimer(): void {
  if (timer) {
    return
  }
  timer = setInterval(pump, FLUSH_POLL_MS)
  ;(timer as { unref?: () => void }).unref?.()
}

function stopTimerIfIdle(): void {
  if (wakes.size === 0 && timer) {
    clearInterval(timer)
    timer = null
  }
}

function drop(workspaceId: string): void {
  if (wakes.delete(workspaceId)) {
    changed()
  }
}

/** Inserts each pane's typing once its transport is attached to the woken terminal. */
function pump(now = Date.now()): void {
  let didChange = false
  for (const [workspaceId, wake] of wakes) {
    if (wake.outcome === 'pending' && now - wake.startedAt > WAKE_INPUT_MAX_HOLD_MS) {
      // Nobody settled this wake: whatever it attaches to now is unknown, so nothing is sent.
      wakes.delete(workspaceId)
      didChange = true
      continue
    }
    if (wake.outcome === 'failed') {
      wakes.delete(workspaceId)
      didChange = true
      continue
    }
    if (wake.settledAt !== null && now - wake.settledAt > WAKE_INPUT_SETTLED_GRACE_MS) {
      wakes.delete(workspaceId)
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
      const { text, submitted } = pane
      wake.panes.delete(paneId)
      didChange = true
      try {
        pane.deliver(text)
        typedPanes.set(paneId, now)
        for (const listener of deliveryListeners) {
          listener({ workspaceId, paneId, submitted })
        }
      } catch {
        // The pane went away mid-delivery; nothing to insert into.
      }
    }
    if (wake.outcome !== 'pending' && wake.panes.size === 0) {
      wakes.delete(workspaceId)
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
    submitted: false,
    deliver,
    isReady,
    sawUnready: false
  }
  pane.deliver = deliver
  pane.isReady = isReady
  const next = applyWakeInput(pane, data)
  pane.text = next.text
  pane.submitted = next.submitted
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
    drop(workspaceId)
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

/** True when typing went to this pane after its last wake (since `since`). */
export function paneReceivedWakeTyping(paneId: string, since: number): boolean {
  const at = typedPanes.get(paneId)
  return at !== undefined && at >= since
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

export function getWakeInputVersion(): number {
  return version
}

/** Tests: drops every wake and stops the pump. */
export function resetWakeInputForTests(): void {
  wakes.clear()
  typedPanes.clear()
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  changed()
}

/** Tests: run one delivery pass now. */
export function pumpWakeInputForTests(now?: number): void {
  pump(now)
}
