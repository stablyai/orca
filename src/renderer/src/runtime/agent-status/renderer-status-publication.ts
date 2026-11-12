import type { AppState } from '@/store/types'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { readRecordChanges } from '@/store/keyed-record-change-reads'
import {
  findRegisteredTerminalTab,
  subscribeMountedTerminalTabChanges
} from '../hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { isWebOnlyMirroredTerminalTab } from '../sync-runtime-graph/mobile-session-surfaces'
import { mobilePublicationEpoch } from '../sync-runtime-graph/graph-state'
import { RendererStatusSender } from './renderer-status-sender'

let sender: RendererStatusSender | undefined
export function rendererStatusGraphAccepted(): void {
  sender?.graphAccepted()
}

export function startRendererStatusPublication(store: {
  getState(): AppState
  subscribe(listener: (state: AppState, previous: AppState) => void): () => void
}): () => void {
  const publication = new RendererStatusSender(
    mobilePublicationEpoch,
    (key) => {
      const state = store.getState()
      const row = state.agentStatusByPaneKey.get(key)
      const identity = parsePaneKey(key)
      if (!row || !identity) {
        return null
      }
      const source = state.agentStatusByPaneKey.projection.mobileSource(key, identity.tabId)
      if (!source) {
        return null
      }
      const layout = state.terminalLayoutsByTabId[identity.tabId]
      // Why: web-only mirrors keep their host's existing status publication path.
      if (isWebOnlyMirroredTerminalTab(source.tab, layout)) {
        return null
      }
      const mounted = findRegisteredTerminalTab(identity.tabId, source.worktreeId)?.tab
      const numericId = mounted?.getManager()?.getNumericIdForLeaf(identity.leafId)
      const rendererPtyId =
        numericId != null
          ? mounted!.getPtyIdForPane(numericId)
          : (layout?.ptyIdsByLeafId?.[identity.leafId] ?? source.tab.ptyId ?? null)
      return { paneKey: key, leafId: identity.leafId, rendererPtyId, row }
    },
    () => store.getState().agentStatusByPaneKey.keys(),
    (batch) => window.api.runtime.syncAgentStatus(batch)
  )
  sender = publication
  const unsubscribeRows = store
    .getState()
    .agentStatusByPaneKey.subscribeChanges((keys) => publication.changed(keys))
  const changedTab = (tabId: string): void =>
    publication.changed(new Set(store.getState().agentStatusByPaneKey.keysForTab(tabId)))
  const unsubscribeBindings = store.subscribe((state, previous) => {
    for (const field of ['terminalLayoutsByTabId', 'ptyIdsByTabId'] as const) {
      const diff = readRecordChanges(state[field], previous[field])
      if (diff?.kind === 'addressed') {
        diff.keys.forEach(changedTab)
      } else if (diff) {
        publication.changed(null)
      }
    }
  })
  const unsubscribeMounts = subscribeMountedTerminalTabChanges((tab) => {
    if (tab) {
      changedTab(tab.tabId)
    }
  })
  return () => {
    unsubscribeRows()
    unsubscribeBindings()
    unsubscribeMounts()
    publication.stop()
    if (sender === publication) {
      sender = undefined
    }
  }
}
