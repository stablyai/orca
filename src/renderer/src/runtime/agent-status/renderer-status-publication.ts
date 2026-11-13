import type { AppState } from '@/store/types'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  findRegisteredTerminalTab,
  subscribeMountedTerminalTabChanges
} from '../hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import {
  getRuntimeLeafIdsForTerminal,
  rendererTerminalBinding,
  isWebOnlyMirroredTerminalTab
} from '../sync-runtime-graph/mobile-session-surfaces'
import { mobilePublicationEpoch } from '../sync-runtime-graph/graph-state'
import { RendererStatusSender } from './renderer-status-sender'

const publicationCursor = { seq: 0 }
let sender: RendererStatusSender | undefined
export function rendererStatusGraphAccepted(): void {
  sender?.graphAccepted()
}

export function startRendererStatusPublication(store: { getState(): AppState }): () => void {
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
      const rendererPtyId = rendererTerminalBinding(
        numericId ?? null,
        numericId == null ? null : mounted!.getPtyIdForPane(numericId),
        layout?.ptyIdsByLeafId?.[identity.leafId],
        () => getRuntimeLeafIdsForTerminal(undefined, layout).length,
        source.tab.ptyId
      )
      return { paneKey: key, leafId: identity.leafId, rendererPtyId, row }
    },
    () => store.getState().agentStatusByPaneKey.keys(),
    (batch) => window.api.runtime.syncAgentStatus(batch),
    publicationCursor
  )
  sender = publication
  const unsubscribeRows = store
    .getState()
    .agentStatusByPaneKey.subscribeChanges((keys) => publication.changed(keys))
  const changedTab = (tabId: string): void =>
    publication.changed(new Set(store.getState().agentStatusByPaneKey.keysForTab(tabId)))
  const unsubscribeMounts = subscribeMountedTerminalTabChanges((tab) => {
    if (tab) {
      changedTab(tab.tabId)
    }
  })
  return () => {
    unsubscribeRows()
    unsubscribeMounts()
    publication.stop()
    if (sender === publication) {
      sender = undefined
    }
  }
}
