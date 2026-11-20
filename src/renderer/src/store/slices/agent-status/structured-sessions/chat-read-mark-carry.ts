import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  chatPaneAddressTabId,
  chatPaneKey
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
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
 * before pane keys followed the conversation. Copy them to the conversation key once; the saved
 * originals are kept.
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
      const current = patch?.[record] ?? marks[record]
      if (current[tabKey] !== undefined && current[key] === undefined) {
        patch ??= {}
        patch[record] = { ...current, [key]: current[tabKey] }
      }
    }
  }
  return patch
}

/** Carries saved read marks for the chat tabs of the named workspaces, or of every workspace. */
export function carryChatReadMarks(
  store: { getState: () => AppState; setState: (patch: Partial<AppState>) => void },
  workspaceIds?: Iterable<string>
): void {
  const state = store.getState()
  const tabsByWorkspace = state.unifiedTabsByWorktree
  const ids = workspaceIds ?? Object.keys(tabsByWorkspace)
  const tabs = function* () {
    for (const id of ids) {
      yield* tabsByWorkspace[id] ?? []
    }
  }
  const patch = carriedChatReadMarks(state, tabs())
  if (patch) {
    store.setState(patch)
  }
}
