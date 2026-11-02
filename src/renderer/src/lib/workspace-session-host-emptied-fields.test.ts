import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionPatch } from '../../../shared/workspace-session-state-types'
import {
  patchWorkspaceSessionByHost,
  type HostPersistenceState
} from './workspace-session-host-persistence'

const RUNTIME = toRuntimeExecutionHostId('env-1')
const WT = 'repo-remote::/srv/project'

// #23914: main merges a patch fieldwise, so a runtime partition the patch omits keeps a closed tab.
async function patchAfterLastBrowserTabCloses(
  state: Partial<HostPersistenceState>
): Promise<Record<string, Record<string, unknown>>> {
  const partitions: Record<string, Record<string, unknown>> = {
    local: { browserTabsByWorktree: {}, browserPagesByWorkspace: {} },
    [RUNTIME]: {
      browserTabsByWorktree: { [WT]: [{ id: 'bw-1', worktreeId: WT }] },
      browserPagesByWorkspace: { 'bw-1': [{ id: 'p-1', workspaceId: 'bw-1' }] }
    }
  }
  await patchWorkspaceSessionByHost(
    {
      get: async () => getDefaultWorkspaceSession(),
      patch: async (patch: WorkspaceSessionPatch, hostId?: ExecutionHostId) => {
        const key = hostId ?? 'local'
        partitions[key] = { ...partitions[key], ...patch }
      }
    },
    { browserTabsByWorktree: {}, browserPagesByWorkspace: {} },
    {
      repos: [{ id: 'repo-remote', connectionId: null, executionHostId: RUNTIME }],
      worktreesByRepo: {},
      tabsByWorktree: {},
      ...state
    }
  ).written
  return partitions
}

describe('a patch that empties a field on a runtime host', () => {
  it('clears the closed tab from a runtime partition this window loaded', async () => {
    const partitions = await patchAfterLastBrowserTabCloses({
      hydratedRuntimeSessionHostIds: [RUNTIME]
    })
    expect(partitions[RUNTIME]?.browserTabsByWorktree).toEqual({})
    expect(partitions[RUNTIME]?.browserPagesByWorkspace).toEqual({})
  })

  it('leaves a runtime partition this window never loaded, or holds parked rows for', async () => {
    const unread = await patchAfterLastBrowserTabCloses({})
    expect(unread[RUNTIME]?.browserTabsByWorktree).toEqual({ [WT]: [expect.anything()] })

    const parked = await patchAfterLastBrowserTabCloses({
      hydratedRuntimeSessionHostIds: [RUNTIME],
      contestedHostWorkspaceSessions: { [RUNTIME]: getDefaultWorkspaceSession() }
    })
    expect(parked[RUNTIME]?.browserPagesByWorkspace).toEqual({
      'bw-1': [expect.anything()]
    })
  })
})
