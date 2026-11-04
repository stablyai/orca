/** Restore sessions runtime wrote to SSH partitions, formerly unread by renderer local/runtime-only hydration (#12721/#18173). */
import { describe, expect, it } from 'vitest'

import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TerminalTab } from '../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'
import '../../../shared/workspace-scope'
import { makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { buildWorkspaceSessionHostSnapshots } from './workspace-session-host-persistence'

const TARGET_ID = 'target-1'
const SSH_HOST_ID: ExecutionHostId = `ssh:${TARGET_ID}`
const REPO_ID = 'repo-remote'
const WORKTREE_PATH = '/remote/checkout/feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

const repos = [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: null }]

function tab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

/** A session read whose partitions are exactly what persistence holds. */
function partitionedApi(
  partitions: Partial<Record<ExecutionHostId | 'local', WorkspaceSessionState>>
) {
  return {
    get: async (hostId?: ExecutionHostId) =>
      partitions[hostId ?? 'local'] ?? getDefaultWorkspaceSession()
  }
}

describe('ssh host partition adoption on a contested bare id', () => {
  /** SSH slices bypass contention splitting because local/SSH usually represents one legacy-split workspace. Same repoId::path across real rival hosts breaks that premise; adoption needs external contest evidence beyond base/host. */
  const RUNTIME_HOST_ID: ExecutionHostId = 'runtime:r1'
  const contestedRepos = [
    { id: REPO_ID, connectionId: TARGET_ID, executionHostId: null },
    { id: 'repo-rt', connectionId: null, executionHostId: RUNTIME_HOST_ID }
  ]

  function contestedPartitions() {
    return {
      local: session({
        tabsByWorktree: {},
        openFilesByWorktree: {
          [WORKTREE_ID]: [
            {
              filePath: '/local/checkout/feature/src/main.ts',
              relativePath: 'src/main.ts',
              worktreeId: WORKTREE_ID,
              language: 'typescript',
              dirtyDraftContent: 'local unsaved work'
            }
          ]
        }
      }),
      [RUNTIME_HOST_ID]: session({
        tabsByWorktree: { [WORKTREE_ID]: [] },
        activeTabTypeByWorktree: { [WORKTREE_ID]: 'terminal' }
      }),
      [SSH_HOST_ID]: session({
        tabsByWorktree: {},
        openFilesByWorktree: {
          [WORKTREE_ID]: [
            {
              filePath: '/remote/checkout/feature/src/other.ts',
              relativePath: 'src/other.ts',
              worktreeId: WORKTREE_ID,
              language: 'typescript'
            }
          ]
        }
      })
    }
  }

  it('still fills a gap on a contested id', async () => {
    // Declining to replace is not declining to repair: a row no claimant answered is still adopted.
    const partitions = contestedPartitions()
    partitions.local = session({ tabsByWorktree: {} })
    const sourceTab = makeUnifiedTab({
      id: 'chat-source',
      entityId: 'session-1',
      groupId: 'chat-group',
      contentType: 'agent-session',
      worktreeId: WORKTREE_ID,
      executionHostId: 'runtime:chat'
    })
    const shadowTab = { ...sourceTab, executionHostId: 'local' as const }
    partitions[SSH_HOST_ID] = session({
      ...partitions[SSH_HOST_ID],
      unifiedTabs: { [WORKTREE_ID]: [sourceTab] },
      activeFileIdByWorktree: { [WORKTREE_ID]: '/remote/checkout/feature/src/other.ts' }
    })

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        ...partitions,
        'runtime:r2': session({ unifiedTabs: { [WORKTREE_ID]: [shadowTab], 'folder:other': [] } })
      }),
      contestedRepos,
      ['runtime:r1', 'runtime:r2']
    )

    expect(read.session.activeFileIdByWorktree?.[WORKTREE_ID]).toBe(
      '/remote/checkout/feature/src/other.ts'
    )
    expect(read.contestedPrimaryHostBySessionKey[WORKTREE_ID]).toBe(RUNTIME_HOST_ID)
    expect(read.session.unifiedTabs?.[WORKTREE_ID]?.[0]).toBe(sourceTab)
    expect(read.contestedHostWorkspaceSessions['runtime:r2']?.unifiedTabs?.[WORKTREE_ID]?.[0]).toBe(
      shadowTab
    )
    const saved = buildWorkspaceSessionHostSnapshots(read.session, {
      repos: contestedRepos,
      worktreesByRepo: {},
      contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey,
      contestedHostWorkspaceSessions: read.contestedHostWorkspaceSessions
    })
    expect(
      saved.find((slice) => slice.hostId === RUNTIME_HOST_ID)?.state.unifiedTabs?.[WORKTREE_ID]?.[0]
    ).toEqual(sourceTab)
    expect(
      saved.find((slice) => slice.hostId === 'runtime:r2')?.state.unifiedTabs?.[WORKTREE_ID]?.[0]
    ).toEqual(shadowTab)
    const reloaded = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(
        Object.fromEntries(saved.map((slice) => [slice.hostId ?? 'local', slice.state]))
      ),
      contestedRepos,
      ['runtime:r1', 'runtime:r2']
    )
    expect(reloaded.session.unifiedTabs?.[WORKTREE_ID]?.[0]).toEqual(sourceTab)
    expect(
      reloaded.contestedHostWorkspaceSessions['runtime:r2']?.unifiedTabs?.[WORKTREE_ID]?.[0]
    ).toEqual(shadowTab)
  })
})

describe('ssh host partition write/read round trip', () => {
  /** Exercise shipping write then read together; hand-built read-shaped fixtures previously hid editor-only workspace loss. */
  async function roundTrip(payload: WorkspaceSessionState): Promise<WorkspaceSessionState> {
    const { buildWorkspaceSessionHostSnapshots } =
      await import('./workspace-session-host-persistence')
    const snapshots = buildWorkspaceSessionHostSnapshots(payload, {
      repos: [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: null }],
      worktreesByRepo: {}
    })
    const partitions: Record<string, WorkspaceSessionState> = {}
    for (const snapshot of snapshots) {
      partitions[snapshot.hostId ?? 'local'] = snapshot.state
    }
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)
    return read.session
  }

  it('sends an editor-only SSH workspace to its partition and reads it back', async () => {
    const restored = await roundTrip(
      session({
        tabsByWorktree: {},
        openFilesByWorktree: {
          [WORKTREE_ID]: [
            {
              filePath: '/remote/checkout/feature/src/app.ts',
              relativePath: 'src/app.ts',
              worktreeId: WORKTREE_ID,
              language: 'typescript',
              dirtyDraftContent: 'work in progress'
            }
          ]
        },
        activeTabTypeByWorktree: { [WORKTREE_ID]: 'editor' }
      })
    )

    expect(restored.openFilesByWorktree?.[WORKTREE_ID]?.[0]?.dirtyDraftContent).toBe(
      'work in progress'
    )
    expect(restored.activeTabTypeByWorktree?.[WORKTREE_ID]).toBe('editor')
  })
})

describe('ssh host partition and the closed-last-terminal tombstone', () => {
  /** Terminal code treats explicit empty lists as last-close tombstones and absence as uninitialized; legacy adoption treats base emptiness as repairable. Assert this boundary against shouldAutoCreateInitialTerminal to prevent repeated reseeding despite a correct write. */
  async function roundTripSession(payload: WorkspaceSessionState): Promise<{
    restored: WorkspaceSessionState
    partitions: Record<string, WorkspaceSessionState>
  }> {
    const { buildWorkspaceSessionHostSnapshots } =
      await import('./workspace-session-host-persistence')
    const snapshots = buildWorkspaceSessionHostSnapshots(payload, {
      repos: [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: null }],
      worktreesByRepo: {}
    })
    const partitions: Record<string, WorkspaceSessionState> = {}
    for (const snapshot of snapshots) {
      partitions[snapshot.hostId ?? 'local'] = snapshot.state
    }
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)
    return { restored: read.session, partitions }
  }

  it('resurrects the legacy-transition shape exactly once and not again', async () => {
    // Known gap must be one-shot: boot one repairs local’s empty legacy half; closing on this build moves tombstone solely to SSH, so boot two cannot resurrect tabs.
    const firstBoot = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({ tabsByWorktree: { [WORKTREE_ID]: [] } }),
        [SSH_HOST_ID]: session({ tabsByWorktree: { [WORKTREE_ID]: [tab('tab-stale')] } })
      }),
      repos
    )
    expect(firstBoot.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-stale'
    ])

    const { restored: secondBoot } = await roundTripSession(
      session({ ...firstBoot.session, tabsByWorktree: { [WORKTREE_ID]: [] } })
    )

    expect(secondBoot.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(
      shouldAutoCreateInitialTerminal(
        secondBoot.tabsByWorktree[WORKTREE_ID]?.length ?? 0,
        Object.hasOwn(secondBoot.tabsByWorktree, WORKTREE_ID)
      )
    ).toBe(false)
  })
})
