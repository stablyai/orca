/** Cover SSH persistence beyond repo-backed repair: folder rows split between renderer local/main SSH, stored partitions absent from repos, and same bare IDs across rival hosts requiring gap-fill-only adoption (#12723). */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'
import {
  buildHostSessionRouting,
  patchWorkspaceSessionByHost,
  type HostPersistenceState
} from './workspace-session-host-persistence'

const TARGET_ID = 'target-1'
const SSH_HOST_ID: ExecutionHostId = `ssh:${TARGET_ID}`
const OTHER_TARGET_ID = 'target-2'
const OTHER_SSH_HOST_ID: ExecutionHostId = `ssh:${OTHER_TARGET_ID}`
const FOLDER_WORKSPACE_ID = 'fw-1'
const FOLDER_KEY = `folder:${FOLDER_WORKSPACE_ID}`
const PROJECT_GROUP_ID = 'pg-1'

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

const sshFolderCatalog = {
  projectGroups: [{ id: PROJECT_GROUP_ID, executionHostId: SSH_HOST_ID }],
  folderWorkspaces: [
    { id: FOLDER_WORKSPACE_ID, projectGroupId: PROJECT_GROUP_ID, executionHostId: SSH_HOST_ID }
  ]
}

describe('ssh folder workspace partition ownership', () => {
  it('routes a folder workspace to the partition main writes it to', () => {
    const routing = buildHostSessionRouting({
      repos: [],
      ...sshFolderCatalog,
      worktreesByRepo: {}
    })

    // RuntimeWorkspaceSessionController.getPreferredHostId answers `ssh:<targetId>` for this key;
    // 'local' here is the two-store split that made SSH tabs disappear on restart.
    expect(routing.hostIdByWorktreeId(FOLDER_KEY)).toBe(SSH_HOST_ID)
  })

  it('keeps a folder row out of the local partition so a save cannot erase main’s copy', async () => {
    const patches: { hostId: ExecutionHostId | undefined; patch: WorkspaceSessionPatch }[] = []
    const state: HostPersistenceState = { repos: [], ...sshFolderCatalog, worktreesByRepo: {} }

    await patchWorkspaceSessionByHost(
      {
        get: async () => getDefaultWorkspaceSession(),
        patch: async (patch, hostId) => {
          patches.push({ hostId, patch })
        }
      },
      { tabsByWorktree: { [FOLDER_KEY]: [tab('tab-desktop', FOLDER_KEY)] } },
      state
    ).written

    // Partition patches replace each supplied field; sending only the sibling folder row would erase main’s original row.
    const sshPatch = patches.find((entry) => entry.hostId === SSH_HOST_ID)?.patch
    expect(Object.keys(sshPatch?.tabsByWorktree ?? {})).toEqual([FOLDER_KEY])
    const localPatch = patches.find((entry) => entry.hostId === undefined)?.patch
    expect(localPatch?.tabsByWorktree?.[FOLDER_KEY]).toBeUndefined()
  })

  it('reads an ssh partition that only a folder workspace owns', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: { [FOLDER_KEY]: [tab('tab-host', FOLDER_KEY)] }
        })
      }),
      // No repo names the target: the catalog-derived partition list cannot see this host at all.
      []
    )

    expect(read.session.tabsByWorktree[FOLDER_KEY]?.map((entry) => entry.id)).toEqual(['tab-host'])
  })
})

describe('ssh partition read source drives the write back', () => {
  const REPO_ID = 'repo-remote'
  const WORKTREE_ID = `${REPO_ID}::/remote/checkout`

  it('returns adopted rows to the partition they were read from with no repo catalog', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-runtime', WORKTREE_ID)] }
        })
      }),
      []
    )

    expect(read.contestedPrimaryHostBySessionKey?.[WORKTREE_ID]).toBe(SSH_HOST_ID)
    const routing = buildHostSessionRouting({
      repos: [],
      worktreesByRepo: {},
      contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey
    })
    // Preserve read-source routing without catalog owners or reunited rows get stranded local again.
    expect(routing.hostIdByWorktreeId(WORKTREE_ID)).toBe(SSH_HOST_ID)
  })
})

describe('a bare workspace id two partitions both hold', () => {
  const REPO_ID = 'repo-duplicated'
  const WORKTREE_ID = `${REPO_ID}::/checkout`
  const DRAFT = 'unsaved draft that no other channel can recover'

  function openFile(
    filePath: string,
    dirtyDraftContent?: string
  ): NonNullable<WorkspaceSessionState['openFilesByWorktree']>[string][number] {
    return {
      filePath,
      relativePath: filePath.slice(filePath.lastIndexOf('/') + 1),
      worktreeId: WORKTREE_ID,
      language: 'typescript',
      dirtyDraftContent
    }
  }

  function collidingPartitions(rivalHostId: ExecutionHostId) {
    return {
      local: session({
        tabsByWorktree: { [WORKTREE_ID]: [] },
        openFilesByWorktree: {
          [WORKTREE_ID]: [openFile('/checkout/a.ts', DRAFT)]
        }
      }),
      [rivalHostId]: session({
        tabsByWorktree: { [WORKTREE_ID]: [tab('tab-rival', WORKTREE_ID)] },
        openFilesByWorktree: { [WORKTREE_ID]: [openFile('/checkout/b.ts')] }
      })
    }
  }

  it('gap-fills instead of replacing, so the local workspace keeps its unsaved draft', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(collidingPartitions(SSH_HOST_ID)),
      // Multi-host catalog repo IDs prove rivalry; local/SSH co-presence alone is the legacy split to repair.
      [
        { id: REPO_ID, connectionId: null, executionHostId: 'local' },
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ]
    )

    expect(read.session.openFilesByWorktree?.[WORKTREE_ID]?.[0]?.dirtyDraftContent).toBe(DRAFT)
  })

  it('still reads an empty base tab row as a gap when the id is contested', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(collidingPartitions(SSH_HOST_ID)),
      [
        { id: REPO_ID, connectionId: null, executionHostId: 'local' },
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ]
    )

    // Empty terminal lists remain adoptable gaps even for contested IDs; treating them as content would publish deletion over live host tabs (#12721).
    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-rival'
    ])
  })

  it('never names the rival partition as the write target for a contested id', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(collidingPartitions(SSH_HOST_ID)),
      // Multi-host catalog repo IDs prove rivalry; local/SSH co-presence alone is the legacy split to repair.
      [
        { id: REPO_ID, connectionId: null, executionHostId: 'local' },
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ]
    )

    // Whole-ID routing to the rival would move the local workspace’s rows; gap-fill must preserve its owner.
    expect(read.contestedPrimaryHostBySessionKey?.[WORKTREE_ID]).not.toBe(SSH_HOST_ID)
  })

  it('gap-fills a contested id from the same partition on every boot', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        // Reverse census insertion order versus host sorting to prove deterministic winners.
        [OTHER_SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-two', WORKTREE_ID)] }
        }),
        // Editor presence gives this contested key a read source while leaving terminal gaps both partitions can fill.
        local: session({ openFilesByWorktree: { [WORKTREE_ID]: [openFile('/checkout/a.ts')] } }),
        [SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-one', WORKTREE_ID)] }
        })
      }),
      // No repo evidence: only duplicate partition membership can prove this contest.
      []
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['tab-one'])
    // Contested ids are withheld from the read-source override, so the write cannot carry one
    // host's rows into the other's partition.
    expect(read.contestedPrimaryHostBySessionKey?.[WORKTREE_ID]).not.toBe(SSH_HOST_ID)
    expect(read.contestedPrimaryHostBySessionKey?.[WORKTREE_ID]).not.toBe(OTHER_SSH_HOST_ID)
  })

  it('does not adopt a contested id the assembled session holds no row for', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-one', WORKTREE_ID)] }
        }),
        [OTHER_SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-two', WORKTREE_ID)] }
        })
      }),
      []
    )

    // Unknown contested IDs lack source overrides; adopting would default write ownership local and re-split storage.
    expect(read.session.tabsByWorktree[WORKTREE_ID]).toBeUndefined()
    expect(read.contestedPrimaryHostBySessionKey?.[WORKTREE_ID]).toBeUndefined()
  })

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

  it('does not adopt a partition the catalog says does not own the workspace', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-stale', WORKTREE_ID)] }
        }),
        [OTHER_SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-live', WORKTREE_ID)] }
        })
      }),
      [{ id: REPO_ID, connectionId: OTHER_TARGET_ID, executionHostId: OTHER_SSH_HOST_ID }]
    )

    // Catalog ownership must defeat earlier-sorting stale partitions or old rows overwrite the live host’s data.
    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['tab-live'])
    expect(read.contestedPrimaryHostBySessionKey?.[WORKTREE_ID]).toBe(OTHER_SSH_HOST_ID)
  })
})

describe('a stray local copy beside a leftover in another ssh partition', () => {
  const REPO_ID = 'repo-remote'
  const WORKTREE_ID = `${REPO_ID}::/remote/checkout/feature`

  it.each([
    [TARGET_ID, OTHER_SSH_HOST_ID],
    [OTHER_TARGET_ID, SSH_HOST_ID]
  ])('keeps the rows of the partition the catalog names (owner %s)', async (owner, leftover) => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({ tabsByWorktree: { [WORKTREE_ID]: [tab('tab-local', WORKTREE_ID)] } }),
        [`ssh:${owner}`]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-live', WORKTREE_ID)] }
        }),
        [leftover]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-leftover', WORKTREE_ID)] }
        })
      }),
      [{ id: REPO_ID, connectionId: owner, executionHostId: null }]
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['tab-live'])
  })
})

describe("an ssh partition left over from before the host's managed server", () => {
  const REPO_ID = 'repo-managed'
  const WORKTREE_ID = `${REPO_ID}::/remote/checkout`
  const RUNTIME_HOST_ID: ExecutionHostId = 'runtime:managed-env'

  it("keeps the runtime partition's rows when this desktop still catalogs the old ssh repo (#34376, #34416)", async () => {
    const runtimeLayout = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, groupId: 'host-group' },
      second: { type: 'leaf' as const, groupId: 'editor-group' }
    }
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [RUNTIME_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-host', WORKTREE_ID)] },
          openFilesByWorktree: {
            [WORKTREE_ID]: [
              {
                filePath: '/remote/checkout/new.ts',
                relativePath: 'new.ts',
                worktreeId: WORKTREE_ID,
                language: 'typescript'
              }
            ]
          },
          tabGroupLayouts: { [WORKTREE_ID]: runtimeLayout }
        }),
        [SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-closed', WORKTREE_ID)] },
          openFilesByWorktree: {
            [WORKTREE_ID]: [
              {
                filePath: '/remote/checkout/closed.ts',
                relativePath: 'closed.ts',
                worktreeId: WORKTREE_ID,
                language: 'typescript'
              }
            ]
          },
          tabGroupLayouts: { [WORKTREE_ID]: { type: 'leaf', groupId: 'ssh-group' } }
        })
      }),
      [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: null }],
      [RUNTIME_HOST_ID],
      new Map([[RUNTIME_HOST_ID, SSH_HOST_ID]])
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['tab-host'])
    expect(read.session.openFilesByWorktree?.[WORKTREE_ID]?.map((f) => f.relativePath)).toEqual([
      'new.ts'
    ])
    expect(read.session.tabGroupLayouts?.[WORKTREE_ID]).toEqual(runtimeLayout)
    expect(read.contestedPrimaryHostBySessionKey?.[WORKTREE_ID]).toBe(RUNTIME_HOST_ID)
    // Declined rows stay parked for their own partition so a downgraded client still finds them.
    expect(
      read.contestedHostWorkspaceSessions[SSH_HOST_ID]?.tabsByWorktree?.[WORKTREE_ID]?.[0]?.id
    ).toBe('tab-closed')
  })
})
