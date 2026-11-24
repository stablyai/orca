import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { repoCreateErrorText } from './repo-create-error-copy'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
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
    throw new Error('Choose this computer or a paired Orca server')
  }
  const owner = host.kind === 'runtime' ? host.environmentId : null
  const now = new Date()
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const name = `${now.toISOString().slice(0, 10)}-${createNonSecureContextUuid()}`
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
  const options = worktreeRefreshOptions(owner)
  await useAppStore.getState().fetchWorktrees(repo.id, options)
  const workspace = selectWorktreesByRepo(useAppStore.getState())[repo.id]?.find(
    (row) => (row.hostId ?? 'local') === options.executionHostId
  )
  if (!workspace) {
    throw new Error('Chat workspace was created but could not be opened. Find it under Chat.')
  }
  activateAndRevealWorktree(workspace.id, {
    sidebarRevealBehavior: 'auto',
    executionHostId: options.executionHostId,
    providesInitialSurface: true
  })
}
