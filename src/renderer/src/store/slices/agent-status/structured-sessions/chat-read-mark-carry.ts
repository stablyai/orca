import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  chatPaneAddressTabId,
  chatPaneKey
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isReopenedChatTabId } from '../../../../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import type { AppState } from '../../../types'

type ReadMarks = Pick<
  AppState,
  'acknowledgedAgentsByPaneKey' | 'activityClearedAtByPaneKey' | 'manuallyUnreadTurnsByPaneKey'
>
const RECORDS = [
  'acknowledgedAgentsByPaneKey',
  'activityClearedAtByPaneKey',
  'manuallyUnreadTurnsByPaneKey'
] as const satisfies readonly (keyof ReadMarks)[]

/**
 * COMPAT(2026-11, remove after 2027-05): a chat in a tab whose id isn't its conversation address
 * (a replaced conversation, a `:history-N` duplicate) saved its read marks under the tab's key
 * before pane keys followed the conversation. Move each to the conversation key, keeping the larger
 * value on collision as the saved pane-key remap does, so a later clear is never undone.
 */
export function carriedChatReadMarks(
  marks: ReadMarks,
  tabs: Iterable<Pick<Tab, 'id' | 'contentType' | 'entityId'>>
): Partial<ReadMarks> | null {
  let patch: Partial<ReadMarks> | null = null
  for (const tab of tabs) {
    if (tab.contentType !== 'agent-session') {
      continue
    }
    const address = chatPaneAddressTabId(tab.entityId)
    if (tab.id === address) {
      continue
    }
    const key = chatPaneKey(tab.entityId)
    const tabKey = `${tab.id}${key.slice(address.length)}`
    for (const record of RECORDS) {
      const carried = (patch?.[record] ?? marks[record])[tabKey]
      if (carried === undefined) {
        continue
      }
      patch ??= {}
      // One clone per record per batch; later moves write into it.
      const next = (patch[record] ??= { ...marks[record] })
      delete next[tabKey]
      const existing = next[key]
      next[key] = existing === undefined ? carried : Math.max(existing, carried)
    }
  }
  return patch
}

/** Run once, after startup hydrates saved read marks and every workspace's tabs. */
export function carryChatReadMarks(store: {
  getState: () => AppState
  setState: (patch: Partial<AppState>) => void
}): void {
  const state = store.getState()
  const patch = carriedChatReadMarks(state, Object.values(state.unifiedTabsByWorktree).flat())
  if (patch) {
    store.setState(patch)
  }
}

const CHAT_ADDRESS_PREFIX = chatPaneAddressTabId('')

function isTabKeyedChatMark(key: string): boolean {
  if (isReopenedChatTabId(key)) {
    return true
  }
  if (!key.startsWith(CHAT_ADDRESS_PREFIX)) {
    return false
  }
  const tabId = key.slice(0, key.lastIndexOf(':'))
  return chatPaneKey(tabId.slice(CHAT_ADDRESS_PREFIX.length)) !== key
}

/** After a saved-UI sync: an older paired client can still acknowledge a chat under its tab's key.
 *  Only keys the sync added are classified, so a sync with none costs one pass over its keys. */
export function carryChatAcknowledgementsAfterSync(
  store: { getState: () => AppState; setState: (patch: Partial<AppState>) => void },
  previous: Record<string, number>
): void {
  const current = store.getState().acknowledgedAgentsByPaneKey
  if (current === previous) {
    return
  }
  for (const key in current) {
    if (previous[key] === undefined && isTabKeyedChatMark(key)) {
      carryChatReadMarks(store)
      return
    }
  }
}
