import { toast } from 'sonner'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  SET_TERMINAL_PANE_TITLE_EVENT,
  type SetTerminalPaneTitleDetail
} from '@/constants/terminal'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  claudeSideChatTitle,
  findClaudeSideChatBySide,
  findClaudeSideChatForParent,
  registerClaudeSideChat
} from '@/lib/claude-side-chat-registry'
import { getAiVaultResumePlatform } from '@/lib/ai-vault-resume-platform'
import { resolveAiVaultResumeStartupShell } from '@/lib/ai-vault-resume-shell'
import { resolveAiVaultResumeHostShell } from '../../../../shared/ai-vault-resume-host-startup'
import {
  buildClaudeSideChatStartup,
  createClaudeSideChatSessionId,
  isClaudeSideChatSessionId
} from '../../../../shared/claude-side-chat'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { dispatchTerminalPaneSplitRequest } from './terminal-pane-split-request-routing'

type SideChatPaneArgs = {
  manager: PaneManager
  pane: ManagedPane
  tabId: string
  worktreeId: string
}

type StatusState = Pick<AppState, 'agentStatusByPaneKey'>

function paneStatus(
  tabId: string,
  leafId: string,
  state: StatusState = useAppStore.getState()
): AgentStatusEntry | undefined {
  return state.agentStatusByPaneKey[makePaneKey(tabId, leafId)]
}

function isSideChatPane(tabId: string, leafId: string, state?: StatusState): boolean {
  return (
    findClaudeSideChatBySide(tabId, leafId) !== null ||
    isClaudeSideChatSessionId(paneStatus(tabId, leafId, state)?.providerSession?.id)
  )
}

/** 'open' on Claude panes, 'return' on a side chat, null elsewhere. */
export type ClaudeSideChatMenuMode = 'open' | 'return' | null

export function claudeSideChatMenuMode(
  state: StatusState,
  tabId: string,
  leafId: string
): ClaudeSideChatMenuMode {
  if (isSideChatPane(tabId, leafId, state)) {
    return findClaudeSideChatBySide(tabId, leafId) ? 'return' : null
  }
  // Shown before the first prompt too, so the action can explain why it must wait.
  return paneStatus(tabId, leafId, state)?.agentType === 'claude' ? 'open' : null
}

function focusLeaf(manager: PaneManager, leafId: string): ManagedPane | null {
  const paneId = manager.getNumericIdForLeaf(leafId)
  if (paneId === null) {
    return null
  }
  manager.setActivePane(paneId, { focus: true })
  return manager.getPanes().find((candidate) => candidate.id === paneId) ?? null
}

/** Codex-style side chat: an ephemeral fork of the pane's Claude conversation, split beside it. Calling it again switches between the two. */
export function toggleClaudeSideChatFromPane(
  args: SideChatPaneArgs & { draftPrompt?: string | null }
): void {
  const { manager, pane, tabId, worktreeId } = args
  const asSide = findClaudeSideChatBySide(tabId, pane.leafId)
  if (asSide) {
    focusLeaf(manager, asSide.parentLeafId)
    return
  }
  if (isSideChatPane(tabId, pane.leafId)) {
    toast.error(
      translate(
        'components.claudeSideChat.nested',
        'A side chat cannot open another side chat. Return to the main chat first.'
      )
    )
    return
  }
  const existing = findClaudeSideChatForParent(tabId, pane.leafId)
  if (existing) {
    const sidePane = focusLeaf(manager, existing.sideLeafId)
    if (sidePane && args.draftPrompt?.trim()) {
      sidePane.terminal.paste(args.draftPrompt)
    }
    return
  }

  const status = paneStatus(tabId, pane.leafId)
  const parentSession = status?.agentType === 'claude' ? status.providerSession : undefined
  if (!parentSession) {
    toast.error(
      translate(
        'components.claudeSideChat.notStarted',
        'Side chat is available once this Claude conversation has started. Send a message first, then try again.'
      )
    )
    return
  }
  const state = useAppStore.getState()
  const host = resolveAiVaultResumeHostShell({
    session: { codexHome: null },
    workspacePlatform: getAiVaultResumePlatform(state, worktreeId),
    localLiveShell: (platform) => resolveAiVaultResumeStartupShell({ state, worktreeId, platform })
  })
  const startup = buildClaudeSideChatStartup({
    parentSession,
    sideSessionId: createClaudeSideChatSessionId(createBrowserUuid()),
    host,
    settings: state.settings,
    model: status?.model,
    draftPrompt: args.draftPrompt
  })
  if (!startup) {
    toast.error(
      translate(
        'components.claudeSideChat.unavailable',
        'This conversation cannot open a side chat.'
      )
    )
    return
  }
  const sideLeafId = createBrowserUuid()
  registerClaudeSideChat({ tabId, parentLeafId: pane.leafId, sideLeafId })
  dispatchTerminalPaneSplitRequest({
    tabId,
    worktreeId,
    paneRuntimeId: pane.id,
    sourceLeafId: pane.leafId,
    direction: 'vertical',
    command: startup.command,
    ...(startup.env ? { env: startup.env } : {}),
    newLeafId: sideLeafId,
    telemetrySource: 'context_menu'
  })
  if (!focusLeaf(manager, sideLeafId)) {
    return
  }
  // Titles only reach mounted panes, so seed it now; the registry keeps it current.
  const detail: SetTerminalPaneTitleDetail = {
    tabId,
    leafId: sideLeafId,
    title: claudeSideChatTitle(status)
  }
  window.dispatchEvent(new CustomEvent(SET_TERMINAL_PANE_TITLE_EVENT, { detail }))
}

/** Quote the selection into the side chat's prompt, like Codex's "ask in side chat". */
function buildClaudeSideChatSelectionDraft(selection: string): string | null {
  const lines = selection.replace(/\r\n?/g, '\n').trim().split('\n')
  if (lines.length === 0 || lines[0] === '') {
    return null
  }
  return `${lines.map((line) => `> ${line}`).join('\n')}\n\n`
}

type ClaudeSideChatMenuActions = {
  menuPaneHasSelection: boolean
  onToggleClaudeSideChat: () => void
  onAskInClaudeSideChat: () => void
}

export function claudeSideChatMenuActions(args: {
  open: boolean
  managerRef: React.RefObject<PaneManager | null>
  resolveMenuPane: () => ManagedPane | null
  tabId: string
  worktreeId: string
}): ClaudeSideChatMenuActions {
  const { managerRef, resolveMenuPane, tabId, worktreeId } = args
  const run = (draftFor: (pane: ManagedPane) => string | null): void => {
    const manager = managerRef.current
    const pane = resolveMenuPane()
    if (manager && pane) {
      toggleClaudeSideChatFromPane({
        manager,
        pane,
        tabId,
        worktreeId,
        draftPrompt: draftFor(pane)
      })
    }
  }
  return {
    // Closed menus skip the pane lookup, like the menu's own target identity.
    menuPaneHasSelection: args.open ? (resolveMenuPane()?.terminal.hasSelection() ?? false) : false,
    onToggleClaudeSideChat: () => run(() => null),
    onAskInClaudeSideChat: () =>
      run((pane) => buildClaudeSideChatSelectionDraft(pane.terminal.getSelection()))
  }
}

/** Tab menus have no pane under the pointer: use the active pane when it takes part, else the tab's first Claude pane. */
export function toggleClaudeSideChatInTab(args: Omit<SideChatPaneArgs, 'pane'>): void {
  const state = useAppStore.getState()
  const panes = args.manager.getPanes()
  const active = args.manager.getActivePane()
  const pane =
    active && claudeSideChatMenuMode(state, args.tabId, active.leafId)
      ? active
      : panes.find(
          (candidate) => claudeSideChatMenuMode(state, args.tabId, candidate.leafId) === 'open'
        )
  if (pane) {
    toggleClaudeSideChatFromPane({ ...args, pane })
  }
}

export function tabHasClaudePane(state: StatusState, tabId: string): boolean {
  const prefix = `${tabId}:`
  return Object.entries(state.agentStatusByPaneKey).some(
    ([paneKey, entry]) =>
      paneKey.startsWith(prefix) &&
      entry.agentType === 'claude' &&
      !isClaudeSideChatSessionId(entry.providerSession?.id)
  )
}
