import { useCallback, useSyncExternalStore } from 'react'

/**
 * Which panes hold a message the user typed but never sent.
 *
 * This is user-input state, not agent status: the agent never reports it, so it
 * cannot live in the hook server's store. It stays a module registry with
 * explicit subscriptions — one notification per pane whose answer changed, so a
 * sidebar row re-renders only when its own pane flips.
 *
 * Cost control: nothing is read on a keystroke. A producer asks for a check, the
 * check coalesces into one trailing pass per pane, and the pane's probe (which
 * owns the expensive part, reading a terminal buffer) runs at most once per pass.
 */

/** Whether the pane's composer holds unsent text, or null when it cannot say. */
export type AgentUnsentDraftProbe = () => boolean | null

export const AGENT_UNSENT_DRAFT_CHECK_DELAY_MS = 500
/** Sending produces no further input, so one late look retires a stale marker. */
export const AGENT_UNSENT_DRAFT_CONFIRM_DELAY_MS = 2_000

const probes = new Map<string, AgentUnsentDraftProbe>()
const panesWithUnsentDraft = new Set<string>()
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
  return panesWithUnsentDraft.has(paneKey)
}

/** Records the answer, notifying only when it actually changed. */
export function setAgentUnsentDraft(paneKey: string, unsent: boolean): void {
  if (unsent === panesWithUnsentDraft.has(paneKey)) {
    return
  }
  if (unsent) {
    panesWithUnsentDraft.add(paneKey)
  } else {
    // Why: only panes that hold a draft are worth an entry, so a cleared pane
    // leaves nothing behind and a closed one cannot accumulate.
    panesWithUnsentDraft.delete(paneKey)
  }
  notify(paneKey)
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
  setAgentUnsentDraft(paneKey, answer)
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
  panesWithUnsentDraft.clear()
  listenersByPaneKey.clear()
}
