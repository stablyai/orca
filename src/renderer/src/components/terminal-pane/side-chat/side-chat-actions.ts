import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { translate } from '@/i18n/i18n'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/non-secure-context-uuid'
import {
  SET_TERMINAL_PANE_TITLE_EVENT,
  type SetTerminalPaneTitleDetail
} from '@/constants/terminal'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  sideChatTitle,
  findSideChatBySide,
  findSideChatForParent,
  registerSideChat,
  unregisterSideChat
} from '@/lib/agent-session/side-chat/side-chat-registry'
import { getAiVaultResumePlatform } from '@/lib/agent-session/resume/history/ai-vault-resume-platform'
import { resolveAiVaultResumeStartupShell } from '@/lib/agent-session/resume/history/ai-vault-resume-shell'
import { resolveAiVaultResumeHostShell } from '../../../../../shared/ai-vault/resume/ai-vault-resume-host-startup'
import {
  isSideChatAgent,
  isSideChatProviderSession
} from '../../../../../shared/agent-launch/side-chat/side-chat'
import {
  buildSideChatStartup,
  sideChatParentSession
} from '../../../../../shared/agent-launch/side-chat/side-chat-startup'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { dispatchTerminalPaneSplitRequest } from '../layout/split/terminal-pane-split-request-routing'

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
  if (findSideChatBySide(tabId, leafId) !== null) {
    return true
  }
  const status = paneStatus(tabId, leafId, state)
  return isSideChatProviderSession(status?.agentType, status?.providerSession)
}

/** 'open' on Claude and omp panes, 'return' on a side chat, null elsewhere. */
export type SideChatMenuMode = 'open' | 'return' | null

export function sideChatMenuMode(
  state: StatusState,
  tabId: string,
  leafId: string
): SideChatMenuMode {
  if (isSideChatPane(tabId, leafId, state)) {
    return findSideChatBySide(tabId, leafId) ? 'return' : null
  }
  // Shown before the first prompt too, so the action can explain why it must wait.
  return isSideChatAgent(paneStatus(tabId, leafId, state)?.agentType) ? 'open' : null
}

function focusLeaf(manager: PaneManager, leafId: string): ManagedPane | null {
  const paneId = manager.getNumericIdForLeaf(leafId)
  if (paneId === null) {
    return null
  }
  manager.setActivePane(paneId, { focus: true })
  return manager.getPanes().find((candidate) => candidate.id === paneId) ?? null
}

/** Codex-style side chat: an ephemeral fork of the pane's agent conversation, split beside it. Calling it again switches between the two. */
export function toggleSideChatFromPane(
  args: SideChatPaneArgs & { draftPrompt?: string | null }
): void {
  const { manager, pane, tabId, worktreeId } = args
  const asSide = findSideChatBySide(tabId, pane.leafId)
  if (asSide) {
    focusLeaf(manager, asSide.parentLeafId)
    return
  }
  if (isSideChatPane(tabId, pane.leafId)) {
    toast.error(
      translate(
        'components.sideChat.nested',
        'A side chat cannot open another side chat. Return to the main chat first.'
      )
    )
    return
  }
  const existing = findSideChatForParent(tabId, pane.leafId)
  if (existing) {
    const sidePane = focusLeaf(manager, existing.sideLeafId)
    if (sidePane) {
      if (args.draftPrompt?.trim()) {
        sidePane.terminal.paste(args.draftPrompt)
      }
      return
    }
    // The split never landed; drop the stale pairing and start a new side chat.
    unregisterSideChat(existing)
  }

  const status = paneStatus(tabId, pane.leafId)
  if (!status || !sideChatParentSession(status)) {
    toast.error(
      translate(
        'components.sideChat.notStarted',
        'Side chat is available once this conversation has started. Send a message first, then try again.'
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
  const startup = buildSideChatStartup({
    parent: status,
    sideChatId: createBrowserUuid(),
    host,
    settings: state.settings,
    draftPrompt: args.draftPrompt
  })
  if (!startup) {
    toast.error(
      translate('components.sideChat.unavailable', 'This conversation cannot open a side chat.')
    )
    return
  }
  const sideLeafId = createBrowserUuid()
  registerSideChat({ tabId, parentLeafId: pane.leafId, sideLeafId })
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
    title: sideChatTitle(status)
  }
  window.dispatchEvent(new CustomEvent(SET_TERMINAL_PANE_TITLE_EVENT, { detail }))
}

/** Quote the selection into the side chat's prompt, like Codex's "ask in side chat". */
function buildSideChatSelectionDraft(selection: string): string | null {
  const lines = selection.replace(/\r\n?/g, '\n').trim().split('\n')
  if (lines.length === 0 || lines[0] === '') {
    return null
  }
  return `${lines.map((line) => `> ${line}`).join('\n')}\n\n`
}

/** Read lazily by the open menu, so building it during render touches no pane refs. */
export type SideChatMenuActions = {
  sideChatMode: () => SideChatMenuMode
  menuPaneHasSelection: () => boolean
  onToggleSideChat: () => void
  onAskInSideChat: () => void
}

export function useSideChatMenuActions(args: {
  managerRef: React.RefObject<PaneManager | null>
  resolveMenuPane: () => ManagedPane | null
  tabId: string
  worktreeId: string
}): SideChatMenuActions {
  const { managerRef, resolveMenuPane, tabId, worktreeId } = args
  const run = useCallback(
    (draftFor: (pane: ManagedPane) => string | null): void => {
      const manager = managerRef.current
      const pane = resolveMenuPane()
      if (manager && pane) {
        toggleSideChatFromPane({ manager, pane, tabId, worktreeId, draftPrompt: draftFor(pane) })
      }
    },
    [managerRef, resolveMenuPane, tabId, worktreeId]
  )
  return useMemo(
    () => ({
      sideChatMode: () => {
        const pane = resolveMenuPane()
        return pane ? sideChatMenuMode(useAppStore.getState(), tabId, pane.leafId) : null
      },
      menuPaneHasSelection: () => resolveMenuPane()?.terminal.hasSelection() ?? false,
      onToggleSideChat: () => run(() => null),
      onAskInSideChat: () =>
        run((pane) => buildSideChatSelectionDraft(pane.terminal.getSelection()))
    }),
    [resolveMenuPane, run, tabId]
  )
}

/** Tab menus have no pane under the pointer: use the active pane when it takes part, else the tab's first Claude or omp pane. */
export function toggleSideChatInTab(args: Omit<SideChatPaneArgs, 'pane'>): void {
  const state = useAppStore.getState()
  const panes = args.manager.getPanes()
  const active = args.manager.getActivePane()
  const pane =
    active && sideChatMenuMode(state, args.tabId, active.leafId)
      ? active
      : panes.find((candidate) => sideChatMenuMode(state, args.tabId, candidate.leafId) === 'open')
  if (pane) {
    toggleSideChatFromPane({ ...args, pane })
  }
}

export function tabHasSideChatAgentPane(state: StatusState, tabId: string): boolean {
  const prefix = `${tabId}:`
  return Object.entries(state.agentStatusByPaneKey).some(
    ([paneKey, entry]) =>
      paneKey.startsWith(prefix) &&
      isSideChatAgent(entry.agentType) &&
      !isSideChatProviderSession(entry.agentType, entry.providerSession)
  )
}
