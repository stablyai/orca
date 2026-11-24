import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { repoCreateErrorText } from './repo-create-error-copy'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { createChatWorkspaceDraft } from '../../../../../../shared/repository/chat-workspace-draft'
import { translate } from '@/i18n/i18n'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { RepoCreateFailure } from '../../../../../../shared/repository/creation/repo-create-failure-copy'
import { upsertAddedRepoWithProjectHostSetup } from '../completion/add-repo-store-upsert'
import {
  worktreeRefreshOptions,
  resolveAddRepoRuntimeTarget
} from '../host-selection/add-repo-runtime-owner'

export async function createChatWorkspace(hostId: ExecutionHostId): Promise<void> {
  const host = parseExecutionHostId(hostId)
  if (!host || host.kind === 'ssh') {
    throw new Error(
      translate('sidebar.chats.hostRequired', 'Choose this computer or a paired Orca server')
    )
  }
  const owner = host.kind === 'runtime' ? host.environmentId : null
  const { name, date } = createChatWorkspaceDraft()
  const result = await callRuntimeRpc<{ repo: Repo } | RepoCreateFailure>(
    resolveAddRepoRuntimeTarget(owner),
    'repo.createChatWorkspace',
    {
      name,
      displayName: translate('sidebar.chats.newProjectDate', 'New project-{{date}}', { date })
    },
    { timeoutMs: 60_000, wake: true }
  ).catch((error: unknown) => {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      throw new Error(
        translate(
          'sidebar.chats.updateHost',
          'Update Orca on the selected host to create a chat workspace.'
        )
      )
    }
    throw error
  })
  if ('error' in result) {
    throw new Error(repoCreateErrorText(result))
  }
  const { repo } = upsertAddedRepoWithProjectHostSetup(result.repo, { runtimeEnvironmentId: owner })
  const state = useAppStore.getState()
  if (state.collapsedGroups.has('sidebar:chats')) {
    state.toggleCollapsedGroup('sidebar:chats')
  }
  const options = worktreeRefreshOptions(owner)
  await useAppStore.getState().fetchWorktrees(repo.id, options)
  const workspace = selectWorktreesByRepo(useAppStore.getState())[repo.id]?.find(
    (row) => (row.hostId ?? 'local') === options.executionHostId
  )
  if (!workspace) {
    throw new Error(
      translate(
        'sidebar.chats.createdNotOpened',
        'Chat workspace was created but could not be opened. Find it under Chats.'
      )
    )
  }
  activateAndRevealWorktree(workspace.id, {
    sidebarRevealBehavior: 'auto',
    executionHostId: options.executionHostId,
    providesInitialSurface: true
  })
}
