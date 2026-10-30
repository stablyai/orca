// Run workspace-seeded launch producers against the real parity store; stub only setup/trust/detection/workspace creation.
import type { LaunchTestStore } from './launch-parity-renderer.test-fixture'
import type * as WorkItemLaunch from '@/lib/launch-work-item-direct'
import type * as FolderComposerSubmit from '@/components/sidebar/folder-workspace-composer-submit'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import {
  LAUNCH_FOLDER_ID,
  type WindowLaunchCase
} from '../../../shared/launch-parity-window-request.test-fixture'

type WorkspaceStartProducer = Extract<
  WindowLaunchCase['producer'],
  { kind: 'work-item' | 'folder-composer' }
>

export type WorkspaceStartModules = {
  workItem: typeof WorkItemLaunch
  folder: typeof FolderComposerSubmit
}

export const loadWorkspaceStartModules = async (): Promise<WorkspaceStartModules> => ({
  workItem: await import('@/lib/launch-work-item-direct'),
  folder: await import('@/components/sidebar/folder-workspace-composer-submit')
})

export async function startWorkspaceAgent(
  modules: WorkspaceStartModules,
  store: LaunchTestStore,
  c: WindowLaunchCase & { producer: WorkspaceStartProducer }
): Promise<void> {
  const { producer } = c
  const state = store.getState()
  // Stub PR refresh without a bridge and let timers drive post-start paste.
  Object.assign(window.api, { gh: {} })
  Object.assign(window, { setTimeout, clearTimeout })
  store.setState({
    ensureDetectedAgents: async () => [producer.agent],
    updateWorktreeMeta: async () => ({ ok: true })
  })
  if (producer.kind === 'work-item') {
    const worktree = state.worktreesByRepo['repo-1']?.[0]
    store.setState({ createWorktree: async () => ({ worktree }) })
    const started = await modules.workItem.launchWorkItemDirect({
      item: {
        title: 'Fix the bug',
        url: 'https://github.com/acme/repo/issues/7',
        type: 'issue',
        number: 7,
        pasteContent: producer.text
      },
      repoId: 'repo-1',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      agentOverride: producer.agent,
      promptDelivery: producer.delivery,
      openModalFallback: () => {
        throw new Error(`${c.name}: fell back to the modal`)
      }
    })
    if (!started) {
      throw new Error(`${c.name}: the work item started no agent`)
    }
    return
  }
  const folderWorkspace = state.folderWorkspaces.find(
    (workspace) => `folder:${workspace.id}` === LAUNCH_FOLDER_ID
  )
  const settings = state.settings
  await modules.folder.submitFolderWorkspaceCreate({
    projectGroup: {
      id: 'pg-1',
      name: 'group',
      parentPath: c.workspace.path,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 0,
      updatedAt: 0
    },
    name: 'folder',
    lastAutoName: '',
    linkedWorkItem: null,
    note: producer.note,
    quickAgent: producer.agent,
    autoRenameBranchFromWork: false,
    agentCmdOverrides: settings?.agentCmdOverrides,
    agentArgs: resolveTuiAgentLaunchArgs(producer.agent, settings),
    agentEnv: resolveTuiAgentLaunchEnv(producer.agent, settings),
    terminalWindowsShell: settings?.terminalWindowsShell,
    launchSource: 'new_workspace_composer',
    createFolderWorkspace: async () => folderWorkspace ?? null,
    onOpenChange: () => {}
  })
}
