import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { buildWorkspaceSessionPayload } from '../../lib/workspace-session'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from '../../lib/workspace-session-host-hydration'
import {
  buildWorkspaceSessionHostSnapshots,
  patchWorkspaceSessionByHost
} from '../../lib/workspace-session-host-persistence'
import { createTestStore, makeLayout, makeTab } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

// A converted host whose rows this build hides: repos:list and folderWorkspaces:list omit them.
const TARGET_ID = 'target-1'
const SSH_HOST: ExecutionHostId = `ssh:${TARGET_ID}`
const HIDDEN_WORKTREE = 'repo-hidden::/srv/app'
// Folder keys stay valid through hydration, so this row is what gives the save an ssh slice.
const HIDDEN_FOLDER = folderWorkspaceKey('folder-hidden')

function hiddenHostPartition(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [HIDDEN_WORKTREE]: [makeTab({ id: 'tab-repo', worktreeId: HIDDEN_WORKTREE, createdAt: 1 })],
      [HIDDEN_FOLDER]: [makeTab({ id: 'tab-folder', worktreeId: HIDDEN_FOLDER, createdAt: 1 })]
    },
    terminalLayoutsByTabId: { 'tab-repo': makeLayout(), 'tab-folder': makeLayout() }
  }
}

/** Main's session channels over in-memory partitions, with or without its hidden-host guard. */
function createSessionBoundary(guarded: boolean) {
  const partitions: Record<string, WorkspaceSessionState> = {
    local: getDefaultWorkspaceSession(),
    [SSH_HOST]: hiddenHostPartition()
  }
  const writable = (hostId?: ExecutionHostId): boolean => !guarded || hostId !== SSH_HOST
  const read = (hostId?: ExecutionHostId): WorkspaceSessionState =>
    structuredClone(partitions[hostId ?? 'local'] ?? getDefaultWorkspaceSession())
  return {
    partitions,
    get: async (hostId?: ExecutionHostId) => read(hostId),
    listHostIds: async (): Promise<ExecutionHostId[]> => [SSH_HOST],
    patch: async (patch: Partial<WorkspaceSessionState>, hostId?: ExecutionHostId) => {
      if (writable(hostId)) {
        partitions[hostId ?? 'local'] = { ...read(hostId), ...structuredClone(patch) }
      }
    },
    setSync: (state: WorkspaceSessionState, hostId?: ExecutionHostId) => {
      if (writable(hostId)) {
        partitions[hostId ?? 'local'] = structuredClone(state)
      }
    }
  }
}

async function bootRenderer(api: ReturnType<typeof createSessionBoundary>) {
  const store = createTestStore()
  const read = await fetchWorkspaceSessionWithRuntimeHostOwners(api, store.getState().repos)
  const options = { additionalValidWorkspaceKeys: [HIDDEN_FOLDER] }
  store.getState().hydrateWorkspaceSession(read.session, {
    ...options,
    runtimeHostIdByWorkspaceSessionKey: read.runtimeHostIdByWorkspaceSessionKey,
    contestedHostWorkspaceSessions: read.contestedHostWorkspaceSessions,
    contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey
  })
  store.getState().hydrateTabsSession(read.session, options)
  return store.getState()
}

async function saveDebouncedPatch(api: ReturnType<typeof createSessionBoundary>) {
  const state = await bootRenderer(api)
  const payload = buildWorkspaceSessionPayload(state)
  await patchWorkspaceSessionByHost(
    api,
    {
      tabsByWorktree: payload.tabsByWorktree,
      terminalLayoutsByTabId: payload.terminalLayoutsByTabId
    },
    state
  ).written
}

async function saveQuitSnapshot(api: ReturnType<typeof createSessionBoundary>) {
  const state = await bootRenderer(api)
  for (const snapshot of buildWorkspaceSessionHostSnapshots(
    buildWorkspaceSessionPayload(state),
    state
  )) {
    api.setSync(snapshot.state, snapshot.hostId)
  }
}

describe('a fenced SSH host keeps its source session partition through renderer saves', () => {
  it('a renderer save alone rewrites the hidden partition without the hidden worktree', async () => {
    const api = createSessionBoundary(false)
    await saveQuitSnapshot(api)
    expect(Object.keys(api.partitions[SSH_HOST]?.tabsByWorktree ?? {})).toEqual([HIDDEN_FOLDER])
  })

  it.each([
    ['debounced patch', saveDebouncedPatch],
    ['quit snapshot', saveQuitSnapshot]
  ])('the %s leaves the fenced partition exactly as exported', async (_name, save) => {
    const api = createSessionBoundary(true)
    await save(api)
    expect(api.partitions[SSH_HOST]).toEqual(hiddenHostPartition())
  })
})
