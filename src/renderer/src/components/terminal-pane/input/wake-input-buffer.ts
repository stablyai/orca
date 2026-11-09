// Typing for a workspace whose server is being woken. Keys typed while the server boots are
// accepted at once (the pane shows them as pending), then delivered in order, exactly once, to
// the terminal the pane is attached to after the wake. They are new intent for the woken
// terminal, typed knowing it is waking, so they never count as input held for the old one
// (#10065 still governs that). Only plain typing survives: escape sequences and control keys
// other than Enter, Tab and Backspace are dropped, since their meaning depends on a screen the
// woken terminal no longer shows.

export const WAKE_INPUT_CAP = 4096
const FLUSH_POLL_MS = 100
/** A wake nobody settles stops holding typing after this; held keys then go to whatever is attached. */
export const WAKE_INPUT_MAX_HOLD_MS = 90_000

type PaneBuffer = {
  data: string
  deliver: (data: string) => void
  isReady: () => boolean
  /** The pane's transport was seen not ready during the wake, so "ready" means re-attached. */
  sawUnready: boolean
}

type WorkspaceWake = {
  startedAt: number
  outcome: 'pending' | 'ready' | 'failed'
  panes: Map<string, PaneBuffer>
}

const wakes = new Map<string, WorkspaceWake>()
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  // Dev builds only: lets e2e drivers read what is held.
  ;(window as unknown as { __orcaWakeInput?: unknown }).__orcaWakeInput = wakes
}
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let version = 0

function changed(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

/** Keeps plain typing (printable text, Enter, Tab, Backspace); drops escape sequences and other controls. */
export function sanitizeWakeInput(data: string): string {
  let out = ''
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!
    const code = ch.charCodeAt(0)
    if (code === 0x1b) {
      // CSI (ESC [ … final), SS3 (ESC O x) or a two-byte escape: skip the whole sequence.
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
    if (code === 0x0d || code === 0x0a || code === 0x09 || code === 0x7f || code === 0x08) {
      out += ch
      continue
    }
    if (code < 0x20 || (code >= 0x80 && code < 0xa0)) {
      continue
    }
    out += ch
  }
  return out
}

function ensureTimer(): void {
  if (timer) {
    return
  }
  timer = setInterval(pump, FLUSH_POLL_MS)
  ;(timer as { unref?: () => void }).unref?.()
}

function stopTimerIfIdle(): void {
  for (const wake of wakes.values()) {
    for (const pane of wake.panes.values()) {
      if (pane.data) {
        return
      }
    }
    if (wake.outcome === 'pending') {
      return
    }
  }
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Delivers each pane's typing once its transport is attached to the woken terminal. */
function pump(): void {
  let didChange = false
  for (const [workspaceId, wake] of wakes) {
    if (wake.outcome === 'pending' && Date.now() - wake.startedAt > WAKE_INPUT_MAX_HOLD_MS) {
      wake.outcome = 'ready'
      didChange = true
    }
    for (const [paneId, pane] of wake.panes) {
      if (!pane.data) {
        continue
      }
      if (wake.outcome === 'failed') {
        pane.data = ''
        didChange = true
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
      const data = pane.data
      pane.data = ''
      didChange = true
      try {
        pane.deliver(data)
      } catch {
        // The pane went away mid-delivery; nothing to replay into.
      }
      wake.panes.delete(paneId)
    }
    if (wake.outcome !== 'pending' && [...wake.panes.values()].every((pane) => !pane.data)) {
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
  if (current && current.startedAt === startedAt && current.outcome === 'pending') {
    return
  }
  wakes.set(workspaceId, {
    startedAt,
    outcome: 'pending',
    // A newer wake keeps typing that is still waiting: it was meant for whatever wakes next.
    panes: current?.outcome === 'failed' ? new Map() : (current?.panes ?? new Map())
  })
  ensureTimer()
  changed()
}

/** The wake settled. `failed` drops held typing (the pane shows the failure instead). */
export function endWorkspaceWake(workspaceId: string, outcome: 'ready' | 'failed'): void {
  const wake = wakes.get(workspaceId)
  if (!wake) {
    return
  }
  wake.outcome = outcome
  changed()
  pump()
}

export function isWorkspaceWaking(workspaceId: string | null | undefined): boolean {
  return Boolean(workspaceId && wakes.get(workspaceId)?.outcome === 'pending')
}

/**
 * Holds `data` typed into `paneId` when its workspace is waking, or when earlier typing from the
 * same pane still waits (so order holds). Returns false when nothing is held and the caller
 * should forward as usual.
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
  if (!wake || (wake.outcome !== 'pending' && !existing?.data)) {
    return false
  }
  const clean = sanitizeWakeInput(data)
  const pane: PaneBuffer = existing ?? { data: '', deliver, isReady, sawUnready: false }
  pane.deliver = deliver
  pane.isReady = isReady
  const room = WAKE_INPUT_CAP - pane.data.length
  if (room > 0 && clean) {
    pane.data += clean.slice(0, room)
  }
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

/** Text typed into the waking workspace, not yet delivered (the pane's pending-input preview). */
export function getWakeInputPreview(workspaceId: string | null | undefined): string {
  const wake = workspaceId ? wakes.get(workspaceId) : undefined
  if (!wake) {
    return ''
  }
  return [...wake.panes.values()].map((pane) => pane.data).join('')
}

export function subscribeWakeInput(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getWakeInputVersion(): number {
  return version
}

/** Tests: drops every wake and stops the pump. */
export function resetWakeInputForTests(): void {
  wakes.clear()
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  changed()
}

/** Tests: run one delivery pass now. */
export function pumpWakeInputForTests(): void {
  pump()
}
