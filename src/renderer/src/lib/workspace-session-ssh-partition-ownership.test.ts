/**
 * Which partition owns an SSH workspace's session, on both sides of the round trip.
 *
 * The sibling round-trip suite pins the repair of a repo-backed worktree whose rows the runtime
 * left in `ssh:<targetId>`. This one pins the three places that repair could not reach:
 *  - a FOLDER workspace, which the renderer routed to 'local' while main's
 *    `RuntimeWorkspaceSessionController` routed the same key to `ssh:<targetId>` — #12723 unfixed,
 *    plus a new erasure once the renderer began writing `ssh:*` at all;
 *  - an SSH partition no repo names, which boot never enumerated and therefore never read;
 *  - a bare `repoId::path` two partitions both hold, which is the one case where "one workspace
 *    written twice" is false and adoption must gap-fill rather than replace.
 */
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
        },
        setSync: () => {}
      },
      { tabsByWorktree: { [FOLDER_KEY]: [tab('tab-desktop', FOLDER_KEY)] } },
      state
    )

    // Main applies a patch field-wise ({ ...current, ...patch }), so a `tabsByWorktree` written to
    // `ssh:<targetId>` WITHOUT the folder row replaces the row main put there.
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
    // Without this the write re-derives an owner from a catalog that cannot name the host, answers
    // 'local', and re-strands the rows it just reunited.
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
      // The catalog registering one repo id on two hosts is the positive evidence that this bare
      // id names two workspaces; co-presence in 'local' and `ssh:*` alone is the repair's own input.
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

    // The #12721 shape - empty list here, the real one in the partition - does not stop being a gap
    // because the id is contested. Reading the empty row as "the base has tabs" is what let the
    // empty list win and then published it back to the host as a deletion.
    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-rival'
    ])
  })

  it('never names the rival partition as the write target for a contested id', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(collidingPartitions(SSH_HOST_ID)),
      // The catalog registering one repo id on two hosts is the positive evidence that this bare
      // id names two workspaces; co-presence in 'local' and `ssh:*` alone is the repair's own input.
      [
        { id: REPO_ID, connectionId: null, executionHostId: 'local' },
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ]
    )

    // Routing the whole bare id to the rival would carry the local workspace's rows into that
    // host's partition — the loss the gap-fill above exists to prevent.
    expect(read.contestedPrimaryHostBySessionKey?.[WORKTREE_ID]).not.toBe(SSH_HOST_ID)
  })

  it('gap-fills a contested id from the same partition on every boot', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        // Listed with the higher host id first so insertion order and sort order disagree: without
        // the sort the winner would follow whichever order the census happened to return.
        [OTHER_SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-two', WORKTREE_ID)] }
        }),
        // The assembled session names the id through its editor row, so the id is not adrift - but
        // it holds no terminal row, which is the gap the two partitions both offer to fill.
        local: session({ openFilesByWorktree: { [WORKTREE_ID]: [openFile('/checkout/a.ts')] } }),
        [SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-one', WORKTREE_ID)] }
        })
      }),
      // Deliberately no repo row: the catalog says nothing, so the only thing that can mark this id
      // contested is the two partitions both naming it.
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

    // A contested id is withheld from the read-source override, so the write re-derives an owner -
    // and with no catalog that answer is 'local'. Adopting the row would move it out of the
    // partition that owns it and into the blob, which is the two-store split this change removes.
    expect(read.session.tabsByWorktree[WORKTREE_ID]).toBeUndefined()
    expect(read.contestedPrimaryHostBySessionKey?.[WORKTREE_ID]).toBeUndefined()
  })

  it('keeps a declined row in its own partition when a sibling workspace is written', async () => {
    const SIBLING_ID = 'repo-sibling::/checkout'
    const partitions = {
      // Explicit empty row: this worktree IS known locally (the #12723 renderer/runtime split,
      // same shape `strandedPartitions()` uses elsewhere) — a gap to fill, not GAP-03's "never
      // heard of this worktree at all" shape that `workspace-session-host-offline-reconnect.test.ts`
      // exercises.
      local: session({ tabsByWorktree: { [SIBLING_ID]: [] } }),
      [SSH_HOST_ID]: session({
        tabsByWorktree: {
          // Contested and held by no other partition, so the read declines it...
          [WORKTREE_ID]: [tab('tab-declined', WORKTREE_ID)],
          // ...while this sibling is adopted and routes back to the same partition.
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
        },
        setSync: () => {}
      },
      { tabsByWorktree: read.session.tabsByWorktree },
      {
        repos: [{ id: 'repo-sibling', connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }],
        worktreesByRepo: {},
        contestedHostWorkspaceSessions: read.contestedHostWorkspaceSessions,
        contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey
      }
    )

    // Main applies a patch field-wise, so an `ssh:<targetId>` write carrying only the sibling would
    // erase the declined row from the one partition that still holds it. Declining to show a row
    // must never mean deleting it.
    const sshTabs = patches.find((entry) => entry.hostId === SSH_HOST_ID)?.patch.tabsByWorktree
    expect(Object.keys(sshTabs ?? {}).sort()).toEqual([SIBLING_ID, WORKTREE_ID].sort())
    expect(sshTabs?.[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['tab-declined'])
  })

  it('does not adopt a partition the catalog says does not own the workspace', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        // Residue: the repo lived here before it moved targets.
        [SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-stale', WORKTREE_ID)] }
        }),
        [OTHER_SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-live', WORKTREE_ID)] }
        })
      }),
      [{ id: REPO_ID, connectionId: OTHER_TARGET_ID, executionHostId: OTHER_SSH_HOST_ID }]
    )

    // `ssh:target-1` sorts first, so without the catalog check its stale row would win the read and
    // then be written into `ssh:target-2`, overwriting the live one.
    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['tab-live'])
    expect(read.contestedPrimaryHostBySessionKey?.[WORKTREE_ID]).toBe(OTHER_SSH_HOST_ID)
  })
})
