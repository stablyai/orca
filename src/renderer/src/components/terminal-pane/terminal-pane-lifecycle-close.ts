import type { CloseTerminalPaneDetail } from '@/constants/terminal'
import type { PaneProcessExit } from './pty-connection-types'

type TerminalPaneCloseManager = {
  closePane: (paneId: number) => void
  detachPaneForExternalMove: (paneId: number) => boolean
  retirePanePreservingPty: (paneId: number) => boolean
  getNumericIdForLeaf: (leafId: string) => number | null
  getPanes: () => unknown[]
}

export function applyTerminalPaneCloseRequest(args: {
  detail: CloseTerminalPaneDetail
  manager: TerminalPaneCloseManager
  closeTab: () => void
  closeTabPreservingPty: () => void
  getPtyIdForLeaf?: (leafId: string) => string | undefined
}): 'ignored' | 'pane' | 'tab' {
  if (
    args.detail.expectedPtyId &&
    (!args.detail.leafId ||
      args.getPtyIdForLeaf?.(args.detail.leafId) !== args.detail.expectedPtyId)
  ) {
    return 'ignored'
  }
  const paneRuntimeId =
    args.detail.paneRuntimeId ??
    (args.detail.leafId ? args.manager.getNumericIdForLeaf(args.detail.leafId) : null)
  if (paneRuntimeId === null || paneRuntimeId === undefined) {
    return 'ignored'
  }
  if (args.manager.getPanes().length <= 1) {
    if (args.detail.preservePty) {
      args.closeTabPreservingPty()
    } else {
      args.closeTab()
    }
    return 'tab'
  }
  if (args.detail.preservePty) {
    if (args.detail.retireSurface) {
      args.manager.retirePanePreservingPty(paneRuntimeId)
    } else {
      args.manager.detachPaneForExternalMove(paneRuntimeId)
    }
  } else {
    args.manager.closePane(paneRuntimeId)
  }
  return 'pane'
}

export function suppressIntentionalPaneCloseExit(
  transport: { getPtyId: () => string | null } | null | undefined,
  suppressPtyExit: (ptyId: string) => void
): string | null {
  const ptyId = transport?.getPtyId() ?? null
  if (ptyId) {
    suppressPtyExit(ptyId)
  }
  return ptyId
}

export function retireMountedTerminalPaneSurface(args: {
  paneKey: string
  leafId: string
  paneId: number
  tabId: string
  ptyId: string | null
  retireAgentPaneAuthority: (
    paneKey: string,
    options?: { preserveSleepingAgentSession?: boolean }
  ) => void
  syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => void
  syncPanePtyLayoutBindingForLeaf?: (
    leafId: string,
    ptyId: string | null,
    sourcePaneId: number
  ) => void
  clearExitedPanePtyLayoutBindingForLeaf?: (leafId: string, exitedPtyId: string) => void
  clearTabPtyId: (tabId: string, ptyId: string) => void
  transport?: {
    detach?: (options?: { preserveExitObserver?: boolean }) => void
    destroy?: () => void
  }
}): void {
  args.retireAgentPaneAuthority(args.paneKey, {
    preserveSleepingAgentSession: true
  })
  if (args.ptyId) {
    if (args.clearExitedPanePtyLayoutBindingForLeaf) {
      // Match the old PTY before clearing so an overlapping successor cannot lose its binding.
      args.clearExitedPanePtyLayoutBindingForLeaf(args.leafId, args.ptyId)
    } else if (args.syncPanePtyLayoutBindingForLeaf) {
      args.syncPanePtyLayoutBindingForLeaf(args.leafId, null, args.paneId)
    } else {
      args.syncPanePtyLayoutBinding(args.paneId, null)
    }
    args.clearTabPtyId(args.tabId, args.ptyId)
  }
  args.transport?.detach?.({ preserveExitObserver: false })
}

export type { PaneProcessExit }
