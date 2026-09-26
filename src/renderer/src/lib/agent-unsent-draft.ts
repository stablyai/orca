import { useCallback, useSyncExternalStore } from 'react'

/**
 * Which panes hold a message the user typed but never sent.
 *
 * This is user-input state, not agent status: the agent never reports it, so it
 * cannot live in the hook server's store. It stays a module registry with
 * explicit subscriptions — one notification per pane whose answer changed, so a
 * sidebar row re-renders only when its own pane flips.
 *
 * Tracked per producer, because one pane key can have two composers behind it: a
 * bridge pane overlays the native chat on the agent's TUI and both write here. A
 * single boolean let the terminal probe clear a native draft that was still
 * waiting, so the row reads the union instead.
 *
 * Cost control: nothing is read on a keystroke. A producer asks for a check, the
 * check coalesces into one trailing pass per pane, and the pane's probe (which
 * owns the expensive part, reading a terminal buffer) runs at most once per pass.
 */

/** Whether the pane's composer holds unsent text, or null when it cannot say. */
export type AgentUnsentDraftProbe = () => boolean | null

/** Which composer answered. A pane can have one of each at the same time. */
export type AgentUnsentDraftSource = 'native-chat' | 'terminal'

export const AGENT_UNSENT_DRAFT_CHECK_DELAY_MS = 500
/** Sending produces no further input, so one late look retires a stale marker. */
export const AGENT_UNSENT_DRAFT_CONFIRM_DELAY_MS = 2_000

const probes = new Map<string, AgentUnsentDraftProbe>()
const sourcesByPaneKey = new Map<string, Set<AgentUnsentDraftSource>>()
const listenersByPaneKey = new Map<string, Set<() => void>>()
const pendingChecks = new Map<string, ReturnType<typeof setTimeout>>()

function notify(paneKey: string): void {
  const listeners = listenersByPaneKey.get(paneKey)
  if (!listeners) {
    return
  }
  for (const listener of listeners) {
    listener()
  }
}

export function hasAgentUnsentDraft(paneKey: string): boolean {
  // Why: only panes with at least one waiting composer keep an entry, so a
  // cleared pane leaves nothing behind and a closed one cannot accumulate.
  return sourcesByPaneKey.has(paneKey)
}

/**
 * Records one producer's answer. The pane's answer is the union, so a composer
 * clearing its own draft cannot speak for the other one, and a listener hears
 * only when that union changes.
 */
export function setAgentUnsentDraft(
  paneKey: string,
  source: AgentUnsentDraftSource,
  unsent: boolean
): void {
  const sources = sourcesByPaneKey.get(paneKey)
  const had = sources !== undefined
  if (unsent) {
    if (sources) {
      sources.add(source)
    } else {
      sourcesByPaneKey.set(paneKey, new Set([source]))
    }
  } else {
    if (!sources) {
      return
    }
    sources.delete(source)
    if (sources.size === 0) {
      sourcesByPaneKey.delete(paneKey)
    }
  }
  if (had !== sourcesByPaneKey.has(paneKey)) {
    notify(paneKey)
  }
}

/**
 * A pane that can answer for itself. Panes without a probe (hibernated, closed,
 * or never mounted) keep whatever was last known — the text is still in the
 * agent's composer, so forgetting it would be a lie.
 */
export function registerAgentUnsentDraftProbe(
  paneKey: string,
  probe: AgentUnsentDraftProbe
): () => void {
  probes.set(paneKey, probe)
  return () => {
    if (probes.get(paneKey) === probe) {
      probes.delete(paneKey)
    }
    const pending = pendingChecks.get(paneKey)
    if (pending) {
      clearTimeout(pending)
      pendingChecks.delete(paneKey)
    }
  }
}

/**
 * Asks the pane to look again, once, after the current burst of input settles.
 * Called on every authorized terminal write, so it must stay allocation-light:
 * a pane already waiting for a pass does nothing here.
 */
function runCheck(paneKey: string, isConfirmation: boolean): void {
  pendingChecks.delete(paneKey)
  const probe = probes.get(paneKey)
  if (!probe) {
    return
  }
  let answer: boolean | null = null
  try {
    answer = probe()
  } catch {
    // A pane torn down mid-pass answers nothing; the last known state stands.
    return
  }
  // Why: a pane that cannot read itself right now must not erase what it last
  // knew — the text is still sitting in the agent's composer.
  if (answer === null) {
    return
  }
  setAgentUnsentDraft(paneKey, 'terminal', answer)
  if (answer && !isConfirmation) {
    schedule(paneKey, AGENT_UNSENT_DRAFT_CONFIRM_DELAY_MS, true)
  }
}

function schedule(paneKey: string, delayMs: number, isConfirmation: boolean): void {
  if (pendingChecks.has(paneKey) || !probes.has(paneKey)) {
    return
  }
  pendingChecks.set(
    paneKey,
    setTimeout(() => runCheck(paneKey, isConfirmation), delayMs)
  )
}

export function scheduleAgentUnsentDraftCheck(paneKey: string): void {
  schedule(paneKey, AGENT_UNSENT_DRAFT_CHECK_DELAY_MS, false)
}

export function subscribeAgentUnsentDraft(paneKey: string, listener: () => void): () => void {
  let listeners = listenersByPaneKey.get(paneKey)
  if (!listeners) {
    listeners = new Set()
    listenersByPaneKey.set(paneKey, listeners)
  }
  const owned = listeners
  owned.add(listener)
  return () => {
    owned.delete(listener)
    if (owned.size === 0 && listenersByPaneKey.get(paneKey) === owned) {
      listenersByPaneKey.delete(paneKey)
    }
  }
}

/** Whether this pane holds a message the user typed and has not sent. */
export function useAgentUnsentDraft(paneKey: string): boolean {
  const getSnapshot = useCallback(() => hasAgentUnsentDraft(paneKey), [paneKey])
  const subscribe = useCallback(
    (listener: () => void) => subscribeAgentUnsentDraft(paneKey, listener),
    [paneKey]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function resetAgentUnsentDraftsForTests(): void {
  for (const pending of pendingChecks.values()) {
    clearTimeout(pending)
  }
  pendingChecks.clear()
  probes.clear()
  sourcesByPaneKey.clear()
  listenersByPaneKey.clear()
}
