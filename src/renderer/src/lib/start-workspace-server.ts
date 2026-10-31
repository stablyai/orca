import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  getKnownExecutionHostIdForWorktree,
  runtimeEnvironmentIdOrLocalUnlessTwin
} from './worktree-runtime-owner'
import { getWorkspaceServerLaunches, type WorkspaceServerLaunch } from './workspace-server-launches'

const starting = new Set<string>()

export async function startWorkspaceServer(entry: WorkspaceServerLaunch): Promise<void> {
  if (starting.has(entry.id)) {
    throw new Error(
      translate(
        'auto.components.right.sidebar.index.serverAlreadyStarting',
        'This server is already starting.'
      )
    )
  }
  starting.add(entry.id)
  try {
    const state = useAppStore.getState()
    const current = getWorkspaceServerLaunches().find((item) => item.id === entry.id)
    if (!current || current.command !== entry.command || current.cwd !== entry.cwd) {
      throw new Error(
        translate(
          'auto.components.right.sidebar.index.serverConfigChanged',
          'The server configuration changed. Try again.'
        )
      )
    }
    const host = getKnownExecutionHostIdForWorktree(state, entry.worktreeId)
    const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, entry.worktreeId)
    if (
      host !== entry.executionHostId ||
      environmentId !==
        (entry.runtimeTarget.kind === 'environment' ? entry.runtimeTarget.environmentId : null)
    ) {
      throw new Error(
        translate(
          'auto.components.right.sidebar.index.serverHostChanged',
          'The workspace execution host changed. Configure this server again.'
        )
      )
    }
    await callRuntimeRpc(entry.runtimeTarget, 'workspaceServers.start', {
      worktree: toRuntimeWorktreeSelector(entry.worktreeId),
      executionHostId: entry.runtimeTarget.kind === 'environment' ? 'local' : entry.executionHostId,
      port: entry.port,
      name: entry.name,
      command: entry.command,
      cwd: entry.cwd
    })
  } finally {
    starting.delete(entry.id)
  }
}

export async function stopWorkspaceServer(
  entry: WorkspaceServerLaunch,
  runId: string
): Promise<void> {
  const state = useAppStore.getState()
  if (
    getKnownExecutionHostIdForWorktree(state, entry.worktreeId) !== entry.executionHostId ||
    runtimeEnvironmentIdOrLocalUnlessTwin(state, entry.worktreeId) !==
      (entry.runtimeTarget.kind === 'environment' ? entry.runtimeTarget.environmentId : null)
  ) {
    throw new Error(
      translate(
        'auto.components.right.sidebar.index.serverHostChanged',
        'The workspace execution host changed. Configure this server again.'
      )
    )
  }
  await callRuntimeRpc(entry.runtimeTarget, 'workspaceServers.stop', {
    worktree: toRuntimeWorktreeSelector(entry.worktreeId),
    port: entry.port,
    runId,
    executionHostId: entry.runtimeTarget.kind === 'environment' ? 'local' : entry.executionHostId
  })
}
