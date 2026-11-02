import type { AppState } from '@/store/types'
import type { Tab } from '../../../shared/tab-types'
import {
  executionHostIdForStructuredTarget,
  legacyStructuredChatRenameOwner,
  structuredAgentSessionTargetForTab
} from './structured-agent-session-owner'

const intents = new WeakMap<() => AppState, Map<string, object>>()

/** Capture the submitted occurrence and address before the rename module loads or navigation moves. */
export function captureStructuredChatRename(get: () => AppState, tab: Tab) {
  const state = get()
  const target = structuredAgentSessionTargetForTab(state, tab)
  const retainAlias = legacyStructuredChatRenameOwner(state, tab) === null
  const owner = target ? executionHostIdForStructuredTarget(target) : tab.executionHostId
  const alias = tab.customLabel ?? null
  const key = JSON.stringify([tab.worktreeId, tab.id])
  let pending = intents.get(get)
  if (!pending) {
    pending = new Map()
    intents.set(get, pending)
  }
  const slots = pending
  const intent = {}
  slots.set(key, intent)
  const currentTab = () =>
    get().unifiedTabsByWorktree[tab.worktreeId]?.find((entry) => entry.id === tab.id)
  const current = () => {
    const entry = currentTab()
    return (
      slots.get(key) === intent &&
      entry?.worktreeId === tab.worktreeId &&
      entry.contentType === tab.contentType &&
      entry.entityId === tab.entityId &&
      entry.agentSessionAgent === tab.agentSessionAgent &&
      entry.createdAt === tab.createdAt &&
      (!entry.executionHostId || entry.executionHostId === owner)
    )
  }
  return {
    target,
    retainAlias,
    current,
    // Alias retirement or another local edit must not cancel the addressed host command.
    aliasCurrent: () => current() && (currentTab()?.customLabel ?? null) === alias,
    finish: () => {
      if (slots.get(key) === intent) {
        slots.delete(key)
      }
    }
  }
}
