import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { TerminalTab } from '../../../shared/types'
import type { AppState } from '@/store/types'
import { createWebRuntimeSessionTerminal } from '@/runtime/web-runtime-session'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'

type FloatingWorkspaceTerminalStore = Pick<
  AppState,
  'activeGroupIdByWorktree' | 'createTab' | 'activateTab' | 'settings'
>

type FloatingWorkspaceShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'target'
>

const FLOATING_WORKSPACE_PANEL_SELECTOR = '[data-floating-terminal-panel]'
const FLOATING_WORKSPACE_SHORTCUT_SURFACE_SELECTOR = '[data-floating-terminal-shortcut-surface]'

function defaultIsMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

export function isFloatingWorkspacePanelVisible(
  doc: Pick<Document, 'querySelector'> = document
): boolean {
  return Boolean(doc.querySelector('[data-floating-terminal-panel][aria-hidden="false"]'))
}

export function isFloatingWorkspacePanelFocused(
  doc: Pick<Document, 'activeElement'> = document
): boolean {
  const active = doc.activeElement
  return active instanceof HTMLElement && active.closest(FLOATING_WORKSPACE_PANEL_SELECTOR) !== null
}

export function isFloatingWorkspaceTerminalInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.closest(FLOATING_WORKSPACE_PANEL_SELECTOR) === null) {
    return false
  }
  return target.classList.contains('xterm-helper-textarea') || target.closest('.xterm') !== null
}

export function isFloatingWorkspacePanelShortcutTarget(
  target: EventTarget | null,
  panelRoot: HTMLElement | null = null
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return (
    target === panelRoot ||
    target.getAttribute('data-floating-terminal-panel') !== null ||
    target.closest(FLOATING_WORKSPACE_SHORTCUT_SURFACE_SELECTOR) !== null
  )
}

export function isFloatingWorkspacePanelShortcut(
  event: FloatingWorkspaceShortcutEvent,
  isMacPlatform = defaultIsMacPlatform(),
  panelRoot: HTMLElement | null = null
): boolean {
  const mod = isMacPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!mod || event.altKey) {
    return false
  }

  const key = event.key.toLowerCase()
  const claimedChord = event.shiftKey
    ? key === 'b' || key === 'm' || key === 'o'
    : key === 't' || key === 'w'
  return claimedChord && isFloatingWorkspacePanelShortcutTarget(event.target, panelRoot)
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
