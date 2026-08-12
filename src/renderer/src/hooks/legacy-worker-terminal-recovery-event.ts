import type { CloseTerminalPaneDetail } from '@/constants/terminal'
import { detachTerminalLayoutLeaf } from '@/components/terminal-pane/terminal-layout-leaf-detach'
import type { AppState } from '@/store'
import { makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'

type LegacyWorkerTerminalRecoveryEvent = {
  paneKey: string
  resolution: 'adopted' | 'exited' | 'rolled_back'
  ptyId?: string
}

export type LegacyWorkerTerminalRecoveryAction =
  | { kind: 'clear-sleeping'; paneKey: string }
  | { kind: 'rollback-surface'; detail: CloseTerminalPaneDetail }
  | { kind: 'ignore' }

export function resolveLegacyWorkerTerminalRecoveryAction(
  event: LegacyWorkerTerminalRecoveryEvent
): LegacyWorkerTerminalRecoveryAction {
  if (event.resolution !== 'rolled_back') {
    return { kind: 'clear-sleeping', paneKey: event.paneKey }
  }
  const pane = parsePaneKey(event.paneKey)
  return pane && event.ptyId
    ? {
        kind: 'rollback-surface',
        detail: {
          tabId: pane.tabId,
          leafId: pane.leafId,
          preservePty: true,
          retireSurface: true,
          expectedPtyId: event.ptyId
        }
      }
    : { kind: 'ignore' }
}

type LegacyWorkerTerminalRecoveryStore = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'setTabLayout'
  | 'clearTabPtyId'
  | 'closeTab'
  | 'retireAgentPaneAuthority'
>

export function rollbackLegacyWorkerTerminalSurfaceInStore(
  store: LegacyWorkerTerminalRecoveryStore,
  detail: CloseTerminalPaneDetail
): 'removed' | 'already-removed' | 'identity-mismatch' {
  const tabExists = Object.values(store.tabsByWorktree).some((tabs) =>
    tabs.some((tab) => tab.id === detail.tabId)
  )
  if (!tabExists) {
    return 'already-removed'
  }
  if (!detail.leafId || !detail.expectedPtyId) {
    return 'identity-mismatch'
  }
  const layout = store.terminalLayoutsByTabId[detail.tabId]
  const boundPtyId = layout?.ptyIdsByLeafId?.[detail.leafId]
  if (!boundPtyId) {
    return 'already-removed'
  }
  if (boundPtyId !== detail.expectedPtyId) {
    return 'identity-mismatch'
  }
  const detached = detachTerminalLayoutLeaf(layout, detail.leafId)
  if (detached) {
    store.retireAgentPaneAuthority(makePaneKey(detail.tabId, detail.leafId), {
      preserveSleepingAgentSession: true
    })
    store.setTabLayout(detail.tabId, detached.sourceLayout)
    store.clearTabPtyId(detail.tabId, detail.expectedPtyId)
  } else {
    store.closeTab(detail.tabId, {
      reason: 'pty-exit',
      captureRecentlyClosed: false
    })
  }
  return 'removed'
}
