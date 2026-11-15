/** Cover SSH persistence beyond repo-backed repair: folder rows split between renderer local/main SSH, stored partitions absent from repos, and same bare IDs across rival hosts requiring gap-fill-only adoption (#12723). */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../../shared/constants'
import {
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../../../shared/workspace-session/workspace-session-state-types'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'
import { patchWorkspaceSessionByHost } from './workspace-session-host-persistence'

const TARGET_ID = 'target-1'
const SSH_HOST_ID: ExecutionHostId = `ssh:${TARGET_ID}`
const OTHER_TARGET_ID = 'target-2'
const OTHER_SSH_HOST_ID: ExecutionHostId = `ssh:${OTHER_TARGET_ID}`

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

/** A session read whose partitions are exactly what persistence holds, plus its census. */
function partitionedApi(partitions: Partial<Record<string, WorkspaceSessionState>>) {
  return {
    get: async (hostId?: ExecutionHostId) =>
      partitions[hostId ?? 'local'] ?? getDefaultWorkspaceSession(),
    // Normalised rather than asserted, the same way the real census filters its storage keys.
    listHostIds: async () =>
      Object.keys(partitions).flatMap((hostId) => normalizeExecutionHostId(hostId) ?? [])
  }
}

describe('a bare workspace id two partitions both hold', () => {
  const REPO_ID = 'repo-duplicated'
  const WORKTREE_ID = `${REPO_ID}::/checkout`

  it('keeps a declined row in its own partition when a sibling workspace is written', async () => {
    const SIBLING_ID = 'repo-sibling::/checkout'
    const partitions = {
      local: session({}),
      [SSH_HOST_ID]: session({
        tabsByWorktree: {
          [WORKTREE_ID]: [tab('tab-declined', WORKTREE_ID)],
          [SIBLING_ID]: [tab('tab-sibling', SIBLING_ID)]
        }
      }),
      [OTHER_SSH_HOST_ID]: session({
        tabsByWorktree: { [WORKTREE_ID]: [tab('tab-rival', WORKTREE_ID)] }
      })
    }
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), [
      { id: 'repo-sibling', connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
    ])
    expect(read.session.tabsByWorktree[WORKTREE_ID]).toBeUndefined()

    const patches: { hostId: ExecutionHostId | undefined; patch: WorkspaceSessionPatch }[] = []
    await patchWorkspaceSessionByHost(
      {
        get: async () => getDefaultWorkspaceSession(),
        patch: async (patch, hostId) => {
          patches.push({ hostId, patch })
        }
      },
      { tabsByWorktree: read.session.tabsByWorktree },
      {
        repos: [{ id: 'repo-sibling', connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }],
        worktreesByRepo: {},
        contestedHostWorkspaceSessions: read.contestedHostWorkspaceSessions,
        contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey
      }
    ).written

    // Field-wise SSH patches must retain declined siblings; not displaying rows must never delete their sole stored copy.
    const sshTabs = patches.find((entry) => entry.hostId === SSH_HOST_ID)?.patch.tabsByWorktree
    expect(Object.keys(sshTabs ?? {}).sort()).toEqual([SIBLING_ID, WORKTREE_ID].sort())
    expect(sshTabs?.[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['tab-declined'])
  })
})
