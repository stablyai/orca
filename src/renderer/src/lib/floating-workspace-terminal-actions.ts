import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { TerminalTab } from '../../../shared/types'
import type { AppState } from '@/store/types'
import { createWebRuntimeSessionTerminal } from '@/runtime/web-runtime-session'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'

type FloatingWorkspaceTerminalStore = Pick<
  AppState,
  'activeGroupIdByWorktree' | 'createTab' | 'activateTab' | 'settings'
>

export function isFloatingWorkspacePanelVisible(
  doc: Pick<Document, 'querySelector'> = document
): boolean {
  return Boolean(doc.querySelector('[data-floating-terminal-panel][aria-hidden="false"]'))
}

export function isFloatingWorkspacePanelFocused(
  doc: Pick<Document, 'activeElement'> = document
): boolean {
  const active = doc.activeElement
  return active instanceof HTMLElement && active.closest('[data-floating-terminal-panel]') !== null
}

export function shouldMinimizeFloatingWorkspacePanelOnCloseShortcut({
  activeView,
  activeWorktreeId,
  floatingTerminalOpen,
  floatingUnifiedTabCount
}: {
  activeView: string
  activeWorktreeId: string | null
  floatingTerminalOpen: boolean
  floatingUnifiedTabCount: number
}): boolean {
  return (
    floatingTerminalOpen &&
    floatingUnifiedTabCount === 0 &&
    activeView === 'terminal' &&
    activeWorktreeId === null
  )
}

export async function createFloatingWorkspaceTerminalTab(
  store: FloatingWorkspaceTerminalStore,
  shellOverride?: string
): Promise<TerminalTab | null> {
  const targetGroupId = store.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  const runtimeEnvironmentId = store.settings?.activeRuntimeEnvironmentId?.trim()
  if (
    await createWebRuntimeSessionTerminal({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      environmentId: runtimeEnvironmentId,
      targetGroupId,
      command: shellOverride,
      activate: true,
      selectWorktree: false
    })
  ) {
    return null
  }

  const tab = store.createTab(FLOATING_TERMINAL_WORKTREE_ID, targetGroupId, shellOverride, {
    activate: false
  })
  store.activateTab(tab.id)
  focusTerminalTabSurface(tab.id)
  return tab
}
