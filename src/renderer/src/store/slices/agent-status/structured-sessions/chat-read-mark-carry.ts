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

const CHAT_ADDRESS_PREFIX = chatPaneAddressTabId('')
const tabKeyedChatMarksByRecord = new WeakMap<Record<string, number>, boolean>()

/** Whether a record still holds a chat mark under a tab's key; once all have moved, carry does no tab work. */
function holdsTabKeyedChatMarks(record: Record<string, number>): boolean {
  let holds = tabKeyedChatMarksByRecord.get(record)
  if (holds === undefined) {
    holds = Object.keys(record).some((key) => {
      if (!key.startsWith(CHAT_ADDRESS_PREFIX)) {
        return false
      }
      const tabId = key.slice(0, key.lastIndexOf(':'))
      return chatPaneKey(tabId.slice(CHAT_ADDRESS_PREFIX.length)) !== key
    })
    tabKeyedChatMarksByRecord.set(record, holds)
  }
  return holds
}

// Tab lists and mark records are replaced, never edited, so a list is rechecked only when it or
// the marks change (a later sync can still bring tab-keyed marks from an older client).
const checkedAgainst = new WeakMap<readonly Tab[], readonly ReadMarks[keyof ReadMarks][]>()

/** Carries saved read marks for the chat tabs of the named workspaces, or of every workspace. */
export function carryChatReadMarks(
  store: { getState: () => AppState; setState: (patch: Partial<AppState>) => void },
  workspaceIds?: Iterable<string>
): void {
  const state = store.getState()
  const records = RECORDS.map((record) => state[record])
  if (!records.some(holdsTabKeyedChatMarks)) {
    return
  }
  const tabsByWorkspace = state.unifiedTabsByWorktree
  const unchecked: (readonly Tab[])[] = []
  for (const id of workspaceIds ?? Object.keys(tabsByWorkspace)) {
    const list = tabsByWorkspace[id]
    const checked = list && checkedAgainst.get(list)
    if (list && !checked?.every((record, index) => record === records[index])) {
      checkedAgainst.set(list, records)
      unchecked.push(list)
    }
  }
  if (unchecked.length === 0) {
    return
  }
  const patch = carriedChatReadMarks(state, unchecked.flat())
  if (patch) {
    store.setState(patch)
    // The move itself replaced the records; the lists it checked stay checked against them.
    const moved = RECORDS.map((record) => store.getState()[record])
    for (const list of unchecked) {
      checkedAgainst.set(list, moved)
    }
  }
}
