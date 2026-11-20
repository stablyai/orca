import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  chatPaneAddressTabId,
  chatPaneKey,
  chatPaneKeySessionId
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isReopenedChatTabId } from '../../../../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import type { AppState } from '../../../types'

type ReadMarks = Pick<
  AppState,
  | 'acknowledgedAgentsByPaneKey'
  | 'activityClearedAtByPaneKey'
  | 'manuallyUnreadTurnsByPaneKey'
  | 'chatReadMarksCarriedFrom'
>
const RECORDS = [
  'acknowledgedAgentsByPaneKey',
  'activityClearedAtByPaneKey',
  'manuallyUnreadTurnsByPaneKey'
] as const satisfies readonly (keyof ReadMarks)[]
type ReadMarkRecord = (typeof RECORDS)[number]
/** A paired web client keeps its own cutoffs and unread turns; the host owns the shared acknowledgements. */
const PAIRING_LOCAL_RECORDS: readonly ReadMarkRecord[] = [
  'activityClearedAtByPaneKey',
  'manuallyUnreadTurnsByPaneKey'
]

/** Which read-mark records this window carries: only the host that owns the shared
 *  acknowledgements carries them, so a client's first start can't copy one back over Mark unread. */
export function chatReadMarkRecordsCarriedHere(
  isPairedWebClient: boolean
): readonly ReadMarkRecord[] {
  return isPairedWebClient ? PAIRING_LOCAL_RECORDS : RECORDS
}

/**
 * COMPAT(2026-11, remove after 2027-05): a chat in a tab whose id isn't its conversation address
 * (a replaced conversation, a reopened tab) saved its read marks under the tab's key before pane
 * keys followed the conversation. Copy each to the conversation key, keeping the larger value on
 * collision as the saved pane-key remap does. Originals stay for older desktops and downgrades;
 * `chatReadMarksCarriedFrom` records each carried value, so only a changed one is carried again and
 * a later Mark unread is never undone.
 */
export function carriedChatReadMarks(
  marks: ReadMarks,
  tabs: Iterable<Pick<Tab, 'id' | 'contentType' | 'entityId'>>,
  records: readonly ReadMarkRecord[] = RECORDS
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
    for (const record of records) {
      const value = marks[record][tabKey]
      const carriedKey = `${record} ${tabKey}`
      const carried = patch?.chatReadMarksCarriedFrom ?? marks.chatReadMarksCarriedFrom
      if (value === undefined || carried[carriedKey] === value) {
        continue
      }
      patch ??= {}
      // One clone per record per batch; later carries write into it.
      const next = (patch[record] ??= { ...marks[record] })
      const existing = next[key]
      next[key] = existing === undefined ? value : Math.max(existing, value)
      ;(patch.chatReadMarksCarriedFrom ??= { ...marks.chatReadMarksCarriedFrom })[carriedKey] =
        value
    }
  }
  return patch
}

/** Run once, after startup hydrates saved read marks and every workspace's tabs. */
export function carryChatReadMarks(
  store: { getState: () => AppState; setState: (patch: Partial<AppState>) => void },
  records: readonly ReadMarkRecord[]
): void {
  const state = store.getState()
  const patch =
    carriedChatReadMarks(state, Object.values(state.unifiedTabsByWorktree).flat(), records) ?? {}
  // Forget carries whose saved tab-keyed mark is gone, so the record stays bounded.
  let carried = patch.chatReadMarksCarriedFrom
  for (const carriedKey in state.chatReadMarksCarriedFrom) {
    const record = RECORDS.find((name) => carriedKey.startsWith(`${name} `))
    if (record === undefined || state[record][carriedKey.slice(record.length + 1)] === undefined) {
      carried ??= { ...state.chatReadMarksCarriedFrom }
      delete carried[carriedKey]
    }
  }
  if (carried) {
    patch.chatReadMarksCarriedFrom = carried
  }
  if (Object.keys(patch).length > 0) {
    store.setState(patch)
  }
}

const CHAT_ADDRESS_PREFIX = chatPaneAddressTabId('')

function isTabKeyedChatMark(key: string): boolean {
  return (
    isReopenedChatTabId(key) ||
    (key.startsWith(CHAT_ADDRESS_PREFIX) && chatPaneKeySessionId(key) === null)
  )
}

/** After a saved-UI sync on the host that owns acknowledgements: an older paired client can still
 *  acknowledge a chat under its tab's key.
 *  Only keys whose value the sync changed are classified, so a sync with none costs one pass. */
export function carryChatAcknowledgementsAfterSync(
  store: { getState: () => AppState; setState: (patch: Partial<AppState>) => void },
  previous: Record<string, number>
): void {
  const current = store.getState().acknowledgedAgentsByPaneKey
  if (current === previous) {
    return
  }
  for (const key in current) {
    if (previous[key] !== current[key] && isTabKeyedChatMark(key)) {
      carryChatReadMarks(store, RECORDS)
      return
    }
  }
}
