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
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
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
  // The host matters too: switching to another host's copy (same id) must cancel a pending launch.
  launchAgentTabShortcut(mainWorktreeId, resolved, () => {
    const state = useAppStore.getState()
    return (
      state.activeWorktreeId === mainWorktreeId &&
      (state.activeWorkspaceExecutionHostId ?? null) === (main.hostId ?? null)
    )
  })
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
    const createdSession: { key: string | null } = { key: null }
    const created = await submitFolderWorkspaceCreate({
      projectGroup,
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: undefined,
      agentCmdOverrides: state.settings?.agentCmdOverrides,
      createFolderWorkspace: async (input) => {
        const result = await state.createFolderWorkspace(input, { runtimeEnvironmentId: null })
        createdSession.key = result ? folderWorkspaceKey(result.folderWorkspace.id) : null
        return result
      },
      onOpenChange: () => {}
    })
    // The submit returns true even when activation fails, and the user may have switched
    // meanwhile: start only in the session this created, once it is the active one.
    const sessionId = createdSession.key
    if (created && sessionId && useAppStore.getState().activeWorktreeId === sessionId) {
      startProjectChat({ id: sessionId, hostId })
    }
  } catch (error) {
    toast.error(getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error)))
  }
}
