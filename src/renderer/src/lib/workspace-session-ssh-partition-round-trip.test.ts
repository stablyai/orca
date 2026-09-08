/**
 * Boot hydration and the remote-workspace round trip for a worktree whose session the
 * main-process runtime wrote into `ssh:<targetId>`.
 *
 * The renderer used to read only the local + `runtime:*` partitions, so those tabs were invisible;
 * the export then published an explicit empty list, `replace-session` made it authoritative, and
 * the next pull applied it as a deletion that re-poisoned the snapshot on every launch
 * (#12721, #18173).
 *
 * Runs the real projection and the real pull-side merge — the failure only exists where the read,
 * the publish and the merge meet, and each of them is individually self-consistent.
 */
import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  exportRemoteWorkspaceSession,
  importRemoteWorkspaceSession
} from '../../../shared/remote-workspace-session-projection'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { mergeDirectSshRemoteWorkspaceSession } from '../hooks/remote-workspace-session-merge'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'

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

/** The observed shape from #12721: the local blob carries the worktree key with an empty list
 *  while the runtime owns the real list in the SSH partition. */
function strandedPartitions(hostTabs: TerminalTab[], localTabs: TerminalTab[] = []) {
  return {
    local: session({ tabsByWorktree: { [WORKTREE_ID]: localTabs } }),
    [SSH_HOST_ID]: session({
      tabsByWorktree: { [WORKTREE_ID]: hostTabs },
      activeTabIdByWorktree: { [WORKTREE_ID]: hostTabs[0]?.id ?? null }
    })
  }
}

describe('ssh host partition hydration', () => {
  it('hydrates tabs the runtime persisted into the ssh partition', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(strandedPartitions([tab('tab-runtime')])),
      repos
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-runtime'
    ])
  })

  it('adopts the stranded workspace rows alongside its tabs', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(strandedPartitions([tab('tab-runtime')])),
      repos
    )

    expect(read.session.activeTabIdByWorktree?.[WORKTREE_ID]).toBe('tab-runtime')
  })

  it('adopts a hibernated agent record the host partition alone holds', async () => {
    // The renderer's next full write replaces the SSH partition, so a runtime-authored record the
    // reunited session never carried would be dropped by the repair itself.
    const partitions = strandedPartitions([tab('tab-runtime')])
    partitions[SSH_HOST_ID] = session({
      ...partitions[SSH_HOST_ID],
      sleepingAgentSessionsByPaneKey: {
        'tab-runtime:leaf-1': {
          paneKey: 'tab-runtime:leaf-1',
          worktreeId: WORKTREE_ID,
          tabId: 'tab-runtime',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'session-1' },
          prompt: 'resume me',
          state: 'done',
          capturedAt: 5,
          updatedAt: 5
        } satisfies SleepingAgentSessionRecord
      }
    })

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)

    expect(
      read.session.sleepingAgentSessionsByPaneKey?.['tab-runtime:leaf-1']?.providerSession.id
    ).toBe('session-1')
  })

  it('leaves a workspace the local partition already holds tabs for untouched', async () => {
    // The other direction of the same rule, and the reason adoption is only gap-filling: merging
    // into a populated row would re-add tabs the user had closed on every launch.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(strandedPartitions([tab('tab-runtime')], [tab('tab-local')])),
      repos
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-local'
    ])
  })

  it("leaves that workspace's other rows alone as well", async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(strandedPartitions([tab('tab-runtime')], [tab('tab-local')])),
      repos
    )

    expect(read.session.activeTabIdByWorktree?.[WORKTREE_ID]).toBeUndefined()
  })

  it('routes the reunited workspace back to the partition that owns it', async () => {
    const { buildHostIdByWorktreeId } = await import('./workspace-session-host-persistence')

    const hostIdByWorktreeId = buildHostIdByWorktreeId({
      repos: [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: null }],
      worktreesByRepo: {}
    })

    expect(hostIdByWorktreeId(WORKTREE_ID)).toBe(SSH_HOST_ID)
  })
})

describe('ssh host partition remote-workspace round trip', () => {
  it('does not delete the worktree tabs across a publish and the next pull', async () => {
    const partitions = strandedPartitions([tab('tab-runtime')])
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)
    // Publish exactly what the renderer now holds, then apply it back as `replace-session` does.
    const published = exportRemoteWorkspaceSession(read.session, {
      isTargetWorktree: (worktreeId) => worktreeId === WORKTREE_ID
    })
    const pulled = importRemoteWorkspaceSession(published, {
      resolveWorktreeId: (worktreePath) => (worktreePath === WORKTREE_PATH ? WORKTREE_ID : null),
      executionHostId: SSH_HOST_ID
    })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      read.session,
      pulled,
      new Set([WORKTREE_ID]),
      read.session.tabsByWorktree,
      new Set(),
      SSH_HOST_ID,
      1
    )

    expect(merged.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['tab-runtime'])
  })

  it('publishes the stranded tabs rather than an empty list', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(strandedPartitions([tab('tab-runtime')])),
      repos
    )

    const published = exportRemoteWorkspaceSession(read.session, {
      isTargetWorktree: (worktreeId) => worktreeId === WORKTREE_ID
    })

    expect(published.tabsByWorktreePath[WORKTREE_PATH]?.map((entry) => entry.id)).toEqual([
      'tab-runtime'
    ])
  })
})
