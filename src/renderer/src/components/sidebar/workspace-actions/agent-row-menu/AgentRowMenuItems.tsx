import { toast } from 'sonner'
import { ArrowUpRight, Folder, Pencil } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { viewClaudeAgentFromRow } from '@/lib/agent-session/navigation/claude-agent-row-view'
import { NativeChatCliForkMenuItems } from '@/components/tab-bar/session-actions/NativeChatCliForkMenuItems'
import { CopyTabIdMenuItem } from '@/components/tab-bar/pane-actions/CopyTabIdMenuItem'
import { requestTerminalTabRename } from '@/components/tab-bar/terminal-tabs/terminal-tab-rename-request'
import type { WorktreeContextMenuModel } from '../context-menu/use-worktree-context-menu-model'
import { WorktreeContextMenuItems } from '../context-menu/WorktreeContextMenuItems'
import {
  getAgentRowMenuActions,
  getAgentRowRenameListenerId,
  hasAgentIncarnationEvidence,
  isSameAgentRowMenuTarget,
  resolveAgentRowMenuTarget,
  type AgentRowMenuTarget
} from './agent-row-menu-target'
import {
  isActiveWorkspaceForCard,
  type AgentRowMenuSession,
  type AgentRowMenuState
} from './use-agent-row-menu'

export function AgentRowMenuItems({
  model,
  menu,
  session
}: {
  model: WorktreeContextMenuModel
  menu: AgentRowMenuState
  session: AgentRowMenuSession
}): React.JSX.Element {
  const t = useTranslate()
  const { target, actions, row, generation } = session
  const workspaceCount = model.activeContextWorktrees.length

  // Every action re-resolves its agent: a closed tab, new PTY or new session is a different agent.
  const resolveCurrent = (): AgentRowMenuTarget | null => {
    const current = resolveAgentRowMenuTarget(useAppStore.getState(), target)
    return isSameAgentRowMenuTarget(target, current) ? current : null
  }
  const notifyGone = (): void => {
    toast.info(t('components.sidebar.agentRowMenu.agentGone', 'This agent is no longer open.'))
  }
  const activate = (): void => {
    session.onActivate(row.tab.id, row.activationPaneKey ?? row.paneKey)
  }

  const handleOpen = (): void => {
    const current = resolveCurrent()
    if (!current) {
      menu.markAgentSelect('restore')
      notifyGone()
      return
    }
    menu.markAgentSelect('agent-action')
    activate()
    const live = useAppStore.getState().agentStatusByPaneKey.get(row.paneKey)
    // Without incarnation evidence the live entry may belong to a different agent than the row showed.
    if (live && hasAgentIncarnationEvidence(current)) {
      void viewClaudeAgentFromRow({ ...row, entry: live })
    }
  }

  const handleRename = (): void => {
    const current = resolveCurrent()
    const state = useAppStore.getState()
    const renameId =
      current &&
      getAgentRowMenuActions(state, current, isActiveWorkspaceForCard(state, model)).rename
        ? getAgentRowRenameListenerId(current)
        : null
    if (!renameId) {
      menu.markAgentSelect('restore')
      notifyGone()
      return
    }
    menu.markAgentSelect('agent-action')
    activate()
    requestTerminalTabRename(renameId)
  }

  const beforeCopy = (): boolean => {
    const current = resolveCurrent()
    menu.markAgentSelect('restore')
    if (!current || !getAgentRowMenuActions(useAppStore.getState(), current, false).copyId) {
      notifyGone()
      return false
    }
    return true
  }

  const beforeFork = (): boolean => {
    const current = resolveCurrent()
    if (!current || !getAgentRowMenuActions(useAppStore.getState(), current, false).fork) {
      menu.closeAgentMenu('restore')
      notifyGone()
      return false
    }
    return true
  }

  return (
    <>
      <DropdownMenuItem onSelect={handleOpen}>
        <ArrowUpRight className="size-3.5" />
        {t('components.sidebar.agentRowMenu.open', 'Open')}
      </DropdownMenuItem>
      {actions.rename ? (
        <DropdownMenuItem onSelect={handleRename}>
          <Pencil className="size-3.5" />
          {t('components.sidebar.agentRowMenu.rename', 'Rename…')}
        </DropdownMenuItem>
      ) : null}
      {actions.fork && target.unifiedTabId && target.chatSessionId && target.chatAgent ? (
        <NativeChatCliForkMenuItems
          tab={{ id: target.unifiedTabId, worktreeId: target.worktreeId }}
          nativeChat={{ sessionId: target.chatSessionId, agent: target.chatAgent }}
          leadingSeparator={false}
          menuKind="dropdown"
          beforeRun={beforeFork}
          requireLocalHost
          onComplete={() => menu.closeAgentMenu('agent-action', generation)}
        />
      ) : null}
      {actions.copyId && target.unifiedTabId ? (
        <CopyTabIdMenuItem
          unifiedTabId={target.unifiedTabId}
          beforeRun={beforeCopy}
          label={t('components.sidebar.agentRowMenu.copyId', 'Copy ID')}
        />
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Folder className="size-3.5" />
          {workspaceCount > 1
            ? t('components.sidebar.agentRowMenu.workspaces', '{{count}} Workspaces', {
                count: workspaceCount,
                defaultValue_one: '{{count}} Workspace'
              })
            : t('components.sidebar.agentRowMenu.workspace', 'Workspace')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent scrollable className="min-w-52">
          <WorktreeContextMenuItems model={model} hideWorkspaceRemoval />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  )
}
