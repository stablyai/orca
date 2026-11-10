import type { OwnedPaneAgentRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

function membership(
  index: Map<string, Set<string>>,
  key: string | undefined | null,
  paneKey: string,
  add: boolean
): void {
  if (!key) {
    return
  }
  if (add) {
    let keys = index.get(key)
    if (!keys) {
      index.set(key, (keys = new Set()))
    }
    keys.add(paneKey)
  } else {
    const keys = index.get(key)
    keys?.delete(paneKey)
    if (keys?.size === 0) {
      index.delete(key)
    }
  }
}
export function indexPaneRecordMembership(
  byTab: Map<string, Set<string>>,
  byConnection: Map<string, Set<string>>,
  record: OwnedPaneAgentRecord,
  add: boolean
): void {
  membership(byTab, parsePaneKey(record.paneKey)?.tabId, record.paneKey, add)
  membership(byConnection, record.connectionId, record.paneKey, add)
}
