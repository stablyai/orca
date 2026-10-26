import type { HookListenerState } from './listener-state'
import { closeJcodeSession } from './jcode-session-registry'

export type JcodeTabOwner = {
  sessionId: string
  paneKey: string
  kind: 'worker' | 'plain'
  rootPaneKey: string
  state: 'creating' | 'open' | 'closed'
}

const TAB_OWNERS_MAX = 256

export function findJcodeSessionOwner(
  state: HookListenerState,
  sessionId: string
): { paneKey: string; role: 'root' | 'worker' | 'plain'; state: 'creating' | 'open' } | undefined {
  const owner = state.jcodeTabOwners.get(sessionId)
  if (owner && owner.state !== 'closed') {
    return { paneKey: owner.paneKey, role: owner.kind, state: owner.state }
  }
  for (const [paneKey, rootId] of state.jcodeSessions.roots) {
    if (rootId === sessionId) {
      return { paneKey, role: 'root', state: 'open' }
    }
  }
  return undefined
}

// A closed refusal means no capacity and nothing recorded: fail and fall back; never focus owner.paneKey.
export function reserveJcodeSessionTab(
  state: HookListenerState,
  owner: Omit<JcodeTabOwner, 'state'>
): { ok: true } | { ok: false; owner: JcodeTabOwner } {
  const existing = findJcodeSessionOwner(state, owner.sessionId)
  if (existing) {
    const tabOwner = state.jcodeTabOwners.get(owner.sessionId)
    return {
      ok: false,
      owner:
        tabOwner && tabOwner.state !== 'closed'
          ? { ...tabOwner }
          : {
              sessionId: owner.sessionId,
              paneKey: existing.paneKey,
              kind: 'plain',
              rootPaneKey: existing.paneKey,
              state: 'open'
            }
    }
  }
  if (!state.jcodeTabOwners.has(owner.sessionId) && state.jcodeTabOwners.size >= TAB_OWNERS_MAX) {
    const closed = [...state.jcodeTabOwners.values()].find((entry) => entry.state === 'closed')
    if (!closed) {
      // Capacity refusal must not report a live tab that callers could focus.
      return { ok: false, owner: { ...owner, state: 'closed' } }
    }
    state.jcodeTabOwners.delete(closed.sessionId)
  }
  state.jcodeTabOwners.set(owner.sessionId, { ...owner, state: 'creating' })
  return { ok: true }
}

export function confirmJcodeSessionTab(
  state: HookListenerState,
  sessionId: string,
  paneKey: string
): boolean {
  const owner = state.jcodeTabOwners.get(sessionId)
  if (!owner || owner.state === 'closed' || owner.paneKey !== paneKey) {
    return false
  }
  owner.state = 'open'
  return true
}

export function closeJcodeSessionTab(state: HookListenerState, paneKey: string): string[] {
  const freed: string[] = []
  for (const [id, owner] of state.jcodeTabOwners) {
    if (owner.paneKey === paneKey) {
      state.jcodeTabOwners.delete(id)
      if (state.jcodeSessions.roots.get(paneKey) === id) {
        closeJcodeSession(state, paneKey, id)
      }
      freed.push(id)
    }
  }
  return freed
}
