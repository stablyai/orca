import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { checkRuntimeGroupHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import { submitFolderWorkspaceCreate } from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace/creation/workspace-create-error-format'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { resolveTerminalAgentTabShortcut } from '@/components/terminal/keyboard-shortcuts/terminal-agent-tab-shortcut'
import { launchAgentTabShortcut } from '@/components/terminal/keyboard-shortcuts/agent-tab-shortcut-launch'

/** Opens the project's main checkout without lifting the sidebar's default-branch filter, then starts the default agent there. */
export function startProjectChat(main: Pick<Worktree, 'id' | 'hostId'>): void {
  const mainWorktreeId = main.id
  const opened = activateAndRevealWorkspace(mainWorktreeId, {
    revealInSidebar: false,
    // The same project on two hosts shares this id; open this host's copy.
    executionHostId: main.hostId
  })
  if (opened === false) {
    return
  }
  const resolved = resolveTerminalAgentTabShortcut({
    activeWorktreeId: mainWorktreeId,
    keybindings: useAppStore.getState().keybindings,
    matchShortcut: (actionId) => actionId === 'tab.newAgent'
  })
  launchAgentTabShortcut(
    mainWorktreeId,
    resolved,
    () => useAppStore.getState().activeWorktreeId === mainWorktreeId
  )
  // A native chat spawns no PTY, so starting one would not otherwise rank the project as recent.
  useAppStore.getState().bumpWorktreeActivity(mainWorktreeId)
}

/**
 * "+ chat" on a folder group: a new group session with the default agent, like a project's
 * "+ chat". Remote groups, and groups whose setup script needs a choice or approval, open the
 * composer instead, which owns that confirmation and the host pick.
 */
export async function startGroupChat(
  projectGroup: ProjectGroup,
  openComposer: (projectGroup: ProjectGroup) => void
): Promise<void> {
  const hostId = getRepoExecutionHostId(projectGroup)
  if (hostId !== LOCAL_EXECUTION_HOST_ID || projectGroup.connectionId) {
    openComposer(projectGroup)
    return
  }
  try {
    const hooks = await checkRuntimeGroupHooks(hostId, projectGroup.id)
    if (hooks.status === 'error' || hooks.unavailable || hooks.setupConfig) {
      openComposer(projectGroup)
      return
    }
    const state = useAppStore.getState()
    const previousActiveId = state.activeWorktreeId
    const created = await submitFolderWorkspaceCreate({
      projectGroup,
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: undefined,
      agentCmdOverrides: state.settings?.agentCmdOverrides,
      createFolderWorkspace: (input) =>
        state.createFolderWorkspace(input, { runtimeEnvironmentId: null }),
      onOpenChange: () => {}
    })
    // The submit activates the new session; only a changed active id proves it opened.
    const sessionId = useAppStore.getState().activeWorktreeId
    if (created && sessionId && sessionId !== previousActiveId) {
      startProjectChat({ id: sessionId, hostId })
    }
  } catch (error) {
    toast.error(getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error)))
  }
}
