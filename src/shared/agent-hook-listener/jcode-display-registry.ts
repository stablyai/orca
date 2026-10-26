import { parsePaneKey } from '../stable-pane-id'
import { bindJcodeRootSession, closeJcodeSession } from './jcode-session-registry'
import { sessionKey } from './jcode-session-ownership'
import type { HookListenerState } from './listener-state'

export {
  closeJcodeSessionTab,
  confirmJcodeSessionTab,
  findJcodeSessionOwner,
  reserveJcodeSessionTab,
  type JcodeTabOwner
} from './jcode-tab-ownership'

export type JcodeDisplayBinding = {
  rootPaneKey: string
  displayPaneKey: string
  sessionId: string
  coordinatorSessionId: string
  tabId: string
  worktreeId?: string
  launchToken?: string
  state: 'open' | 'closed'
  boundAt: number
}

const DISPLAY_BINDINGS_MAX = 256

export function bindJcodeDisplaySession(
  state: HookListenerState,
  binding: JcodeDisplayBinding
): boolean {
  const owner = state.jcodeTabOwners.get(binding.sessionId)
  const key = sessionKey(binding.rootPaneKey, binding.sessionId)
  const existing = state.jcodeDisplayBindings.get(key)
  if (
    !owner ||
    owner.kind !== 'worker' ||
    owner.state === 'closed' ||
    owner.paneKey !== binding.displayPaneKey ||
    owner.rootPaneKey !== binding.rootPaneKey ||
    binding.state !== 'open' ||
    !parsePaneKey(binding.displayPaneKey) ||
    state.jcodeSessions.roots.get(binding.rootPaneKey) !== binding.coordinatorSessionId ||
    existing?.state === 'closed' ||
    (existing && existing.displayPaneKey !== binding.displayPaneKey)
  ) {
    return false
  }
  const evicted =
    !existing && state.jcodeDisplayBindings.size >= DISPLAY_BINDINGS_MAX
      ? [...state.jcodeDisplayBindings.entries()].find(([, entry]) => entry.state === 'closed')
      : undefined
  if (!existing && state.jcodeDisplayBindings.size >= DISPLAY_BINDINGS_MAX && !evicted) {
    return false
  }
  if (!bindJcodeRootSession(state, binding.displayPaneKey, binding.sessionId, 'launch')) {
    return false
  }
  if (evicted) {
    state.jcodeDisplayBindings.delete(evicted[0])
  }
  state.jcodeDisplayBindings.set(key, { ...binding })
  return true
}

export function lookupJcodeDisplayBinding(
  state: HookListenerState,
  rootPaneKey: string,
  sessionId: string
): JcodeDisplayBinding | undefined {
  const binding = state.jcodeDisplayBindings.get(sessionKey(rootPaneKey, sessionId))
  return binding ? { ...binding } : undefined
}

export function releaseJcodeSessionTab(
  state: HookListenerState,
  sessionId: string,
  paneKey: string
): void {
  if (state.jcodeTabOwners.get(sessionId)?.paneKey === paneKey) {
    state.jcodeTabOwners.delete(sessionId)
  }
  for (const [key, binding] of state.jcodeDisplayBindings) {
    if (
      binding.sessionId === sessionId &&
      binding.displayPaneKey === paneKey &&
      binding.state === 'open'
    ) {
      closeJcodeSession(state, paneKey, sessionId)
      state.jcodeDisplayBindings.delete(key)
    }
  }
}

export function settleJcodeDisplayPane(state: HookListenerState, displayPaneKey: string): boolean {
  let found = false
  for (const binding of state.jcodeDisplayBindings.values()) {
    if (binding.displayPaneKey !== displayPaneKey) {
      continue
    }
    found = true
    binding.state = 'closed'
    const owner = state.jcodeTabOwners.get(binding.sessionId)
    if (owner?.paneKey === displayPaneKey) {
      owner.state = 'closed'
    }
    closeJcodeSession(state, displayPaneKey, binding.sessionId)
  }
  return found
}

export function jcodeDisplayPanesOfRoot(state: HookListenerState, rootPaneKey: string): string[] {
  const panes = new Set<string>()
  for (const binding of state.jcodeDisplayBindings.values()) {
    if (binding.rootPaneKey === rootPaneKey && binding.state === 'open') {
      panes.add(binding.displayPaneKey)
    }
  }
  for (const owner of state.jcodeTabOwners.values()) {
    if (owner.rootPaneKey === rootPaneKey && owner.kind === 'worker' && owner.state !== 'closed') {
      panes.add(owner.paneKey)
    }
  }
  return [...panes]
}

export function jcodePaneRetirementState(state: HookListenerState, paneKey: string) {
  const owners = [...state.jcodeTabOwners.values()]
  const openChildren = new Set(
    owners.filter((owner) => owner.state === 'open').map((owner) => owner.paneKey)
  )
  const hasOwner = owners.some((owner) => owner.paneKey === paneKey)
  let hasBinding = false
  let hasRootBindings = false
  for (const binding of state.jcodeDisplayBindings.values()) {
    hasBinding ||= binding.displayPaneKey === paneKey
    hasRootBindings ||= binding.rootPaneKey === paneKey
  }
  return { openChildren, hasOwner, hasBinding, hasRootBindings }
}

export function clearJcodeDisplayBindingsOfRoot(
  state: HookListenerState,
  rootPaneKey: string
): void {
  for (const [key, binding] of state.jcodeDisplayBindings) {
    if (binding.rootPaneKey === rootPaneKey) {
      closeJcodeSession(state, binding.displayPaneKey, binding.sessionId)
      state.jcodeDisplayBindings.delete(key)
    }
  }
  for (const [id, owner] of state.jcodeTabOwners) {
    if (owner.rootPaneKey === rootPaneKey && owner.kind === 'worker') {
      state.jcodeTabOwners.delete(id)
    }
  }
}

export function moveJcodeDisplayBindings(
  state: HookListenerState,
  fromPaneKey: string,
  toPaneKey: string
): void {
  for (const owner of state.jcodeTabOwners.values()) {
    if (owner.paneKey === fromPaneKey) {
      owner.paneKey = toPaneKey
    }
    if (owner.rootPaneKey === fromPaneKey) {
      owner.rootPaneKey = toPaneKey
    }
  }
  for (const [key, binding] of state.jcodeDisplayBindings) {
    if (binding.rootPaneKey === fromPaneKey) {
      state.jcodeDisplayBindings.delete(key)
      binding.rootPaneKey = toPaneKey
      state.jcodeDisplayBindings.set(sessionKey(toPaneKey, binding.sessionId), binding)
    }
    if (binding.displayPaneKey === fromPaneKey) {
      binding.displayPaneKey = toPaneKey
      binding.tabId = parsePaneKey(toPaneKey)?.tabId ?? binding.tabId
    }
  }
}

type JcodeStampedEnvelope = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  launchToken?: string
}

export function resolveJcodeDisplayEnvelope(args: {
  state: HookListenerState
  stamped: JcodeStampedEnvelope
  sessionId: string | undefined
}): { kind: 'pass' } | { kind: 'route'; envelope: JcodeStampedEnvelope } | { kind: 'drop' } {
  const binding = args.sessionId
    ? lookupJcodeDisplayBinding(args.state, args.stamped.paneKey, args.sessionId)
    : undefined
  if (!binding) {
    return { kind: 'pass' }
  }
  if (binding.state === 'closed') {
    return { kind: 'drop' }
  }
  return {
    kind: 'route',
    envelope: {
      paneKey: binding.displayPaneKey,
      tabId: parsePaneKey(binding.displayPaneKey)?.tabId,
      worktreeId: binding.worktreeId,
      launchToken: binding.launchToken
    }
  }
}
