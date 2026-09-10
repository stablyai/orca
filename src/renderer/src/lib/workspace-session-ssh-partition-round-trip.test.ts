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
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
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

describe('ssh host partition workspaces with no terminal tabs', () => {
  /** An SSH workspace the user left with an editor open and every terminal closed. Orca does not
   *  auto-create a terminal while other tabs exist, so this is an ordinary state — and the whole
   *  workspace now persists to `ssh:<targetId>`, tabs or no tabs. */
  function editorOnlyPartitions() {
    return {
      local: session({ tabsByWorktree: {} }),
      [SSH_HOST_ID]: session({
        tabsByWorktree: { [WORKTREE_ID]: [] },
        openFilesByWorktree: {
          [WORKTREE_ID]: [
            {
              filePath: '/remote/checkout/feature/src/main.ts',
              relativePath: 'src/main.ts',
              worktreeId: WORKTREE_ID,
              language: 'typescript',
              dirtyDraftContent: 'unsaved work'
            }
          ]
        },
        activeFileIdByWorktree: { [WORKTREE_ID]: '/remote/checkout/feature/src/main.ts' },
        activeTabTypeByWorktree: { [WORKTREE_ID]: 'editor' },
        browserTabsByWorktree: {
          [WORKTREE_ID]: [{ id: 'browser-1', name: 'Docs', tabs: [], activeTabId: null }]
        },
        lastVisitedAtByWorktreeId: { [`${SSH_HOST_ID}|${WORKTREE_ID}`]: 4242 }
      } as unknown as WorkspaceSessionState)
    }
  }

  it('restores the open editor files', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(editorOnlyPartitions()),
      repos
    )

    expect(
      read.session.openFilesByWorktree?.[WORKTREE_ID]?.map((file) => file.relativePath)
    ).toEqual(['src/main.ts'])
  })

  it('restores an unsaved hot-exit draft, which no other channel can recover', async () => {
    // RemoteWorkspaceSession carries terminal fields only, so the SSH host snapshot cannot
    // round-trip editor state. Losing it here loses user-authored content outright.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(editorOnlyPartitions()),
      repos
    )

    expect(read.session.openFilesByWorktree?.[WORKTREE_ID]?.[0]?.dirtyDraftContent).toBe(
      'unsaved work'
    )
  })

  it('restores browser workspaces and the active tab type', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(editorOnlyPartitions()),
      repos
    )

    expect(read.session.browserTabsByWorktree?.[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'browser-1'
    ])
    expect(read.session.activeTabTypeByWorktree?.[WORKTREE_ID]).toBe('editor')
  })

  it('restores a workspace the host partition names with no tabs row at all', async () => {
    // Stricter than the fixtures above, which carry an empty `tabsByWorktree` key. A workspace that
    // never had a terminal has no such key, so tab presence cannot be what discovers it.
    const partitions = {
      local: session({ tabsByWorktree: {} }),
      [SSH_HOST_ID]: session({
        tabsByWorktree: {},
        openFilesByWorktree: {
          [WORKTREE_ID]: [
            {
              filePath: '/remote/checkout/feature/README.md',
              relativePath: 'README.md',
              worktreeId: WORKTREE_ID,
              language: 'markdown',
              dirtyDraftContent: 'never saved'
            }
          ]
        }
      } as unknown as WorkspaceSessionState)
    }

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)

    expect(read.session.openFilesByWorktree?.[WORKTREE_ID]?.[0]?.dirtyDraftContent).toBe(
      'never saved'
    )
  })

  it('restores host-qualified visit recency, which is keyed by host and not by bare id', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(editorOnlyPartitions()),
      repos
    )

    expect(read.session.lastVisitedAtByWorktreeId?.[`${SSH_HOST_ID}|${WORKTREE_ID}`]).toBe(4242)
  })
})

describe('ssh host partition rows the host has nothing for', () => {
  /** The base half of a legacy split: `local` still holds this workspace's editor state, including
   *  an unsaved draft, while the SSH partition holds only empty rows for it. The workspace is
   *  adoptable (the base has no terminal tabs for it), and every worktree-keyed row it adopts is a
   *  replacing write — so an empty host row landing on a populated base row is a real deletion. */
  function emptyHostRowsOverBaseDraft(hostOpenFiles: boolean) {
    const draftFile = {
      filePath: `${WORKTREE_PATH}/src/main.ts`,
      relativePath: 'src/main.ts',
      worktreeId: WORKTREE_ID,
      language: 'typescript',
      dirtyDraftContent: 'unsaved work'
    }
    return {
      local: session({
        tabsByWorktree: {},
        openFilesByWorktree: { [WORKTREE_ID]: [draftFile] },
        activeTabTypeByWorktree: { [WORKTREE_ID]: 'editor' }
      } as unknown as WorkspaceSessionState),
      [SSH_HOST_ID]: session({
        tabsByWorktree: { [WORKTREE_ID]: [] },
        ...(hostOpenFiles ? { openFilesByWorktree: { [WORKTREE_ID]: [] } } : {})
      } as unknown as WorkspaceSessionState)
    }
  }

  it('does not let an empty host row destroy an unsaved draft the base alone holds', async () => {
    // The host having no open files is not evidence the base's are gone. Losing this is worse than
    // the bug the adoption exists to fix: RemoteWorkspaceSession carries terminal fields only, so
    // nothing can recover a `dirtyDraftContent` once the read has dropped it.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(emptyHostRowsOverBaseDraft(true) as never),
      repos
    )

    expect(read.session.openFilesByWorktree?.[WORKTREE_ID]?.[0]?.dirtyDraftContent).toBe(
      'unsaved work'
    )
  })

  it('still adopts a populated host row over the base leftovers', async () => {
    // The other side of the same rule: the guard must be about the host having nothing, not about
    // the base having something, or adoption stops repairing the split it exists for.
    const partitions = emptyHostRowsOverBaseDraft(false)
    partitions[SSH_HOST_ID] = session({
      ...partitions[SSH_HOST_ID],
      openFilesByWorktree: {
        [WORKTREE_ID]: [
          {
            filePath: `${WORKTREE_PATH}/src/host.ts`,
            relativePath: 'src/host.ts',
            worktreeId: WORKTREE_ID,
            language: 'typescript'
          }
        ]
      }
    } as unknown as WorkspaceSessionState)

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(partitions as never),
      repos
    )

    expect(
      read.session.openFilesByWorktree?.[WORKTREE_ID]?.map((file) => file.relativePath)
    ).toEqual(['src/host.ts'])
  })

  it('adopts the layout of a tab the host slice names only in unifiedTabs', async () => {
    // `buildWorktreeIdByTabId` — the index the split routes by — resolves unified-only tabs as well
    // as `tabsByWorktree` ones, so their tab-keyed rows are written to this partition. A read that
    // discovered tabs from `tabsByWorktree` alone routed them in and never brought them back.
    const partitions = {
      local: session({ tabsByWorktree: {} }),
      [SSH_HOST_ID]: session({
        tabsByWorktree: {},
        unifiedTabs: {
          [WORKTREE_ID]: [{ id: 'tab-unified', type: 'terminal', worktreeId: WORKTREE_ID }]
        },
        terminalLayoutsByTabId: { 'tab-unified': { direction: 'row', panes: [] } }
      } as unknown as WorkspaceSessionState)
    }

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(partitions as never),
      repos
    )

    expect(read.session.terminalLayoutsByTabId?.['tab-unified']).toBeDefined()
  })
})

describe('ssh host partition adoption on a contested bare id', () => {
  /** A worktree id is `repoId::path` with no host component, so one repo registered on two hosts
   *  publishes the SAME id for two DIFFERENT workspaces (STA-4343). The contention split parks the
   *  co-claimant's rows so the primary's write cannot erase them — but ssh slices are deliberately
   *  kept out of that claimant set, on the premise that `local` and `ssh:<target>` are one workspace
   *  written twice. A contested id is exactly where that premise fails, and adoption cannot see it
   *  from `(base, host)` alone. */
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
      } as unknown as WorkspaceSessionState),
      [RUNTIME_HOST_ID]: session({
        tabsByWorktree: { [WORKTREE_ID]: [] },
        activeTabTypeByWorktree: { [WORKTREE_ID]: 'terminal' }
      } as unknown as WorkspaceSessionState),
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
      } as unknown as WorkspaceSessionState)
    }
  }

  it("does not overwrite a contested workspace's own rows with the ssh workspace's", async () => {
    // The read names `local` primary for this id and parks the runtime claimant, so routing writes
    // whatever survives here back into local's own partition. Replacing local's rows with the SSH
    // workspace's would persist one workspace's editor state as another's — and destroy the draft.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(contestedPartitions() as never),
      contestedRepos
    )

    expect(read.session.openFilesByWorktree?.[WORKTREE_ID]?.[0]?.dirtyDraftContent).toBe(
      'local unsaved work'
    )
  })

  it('still fills a gap on a contested id', async () => {
    // Declining to replace is not declining to repair: a row no claimant answered is still adopted.
    const partitions = contestedPartitions()
    partitions[SSH_HOST_ID] = session({
      ...partitions[SSH_HOST_ID],
      activeFileIdByWorktree: { [WORKTREE_ID]: '/remote/checkout/feature/src/other.ts' }
    } as unknown as WorkspaceSessionState)

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(partitions as never),
      contestedRepos
    )

    expect(read.session.activeFileIdByWorktree?.[WORKTREE_ID]).toBe(
      '/remote/checkout/feature/src/other.ts'
    )
  })

  it('does not let a legacy bare recency key move another host workspace of the same id', async () => {
    // `lastVisitedAtByWorktreeId` is the one worktree-keyed field whose key may name its own host,
    // and the split has a dedicated branch for that. A bare key carries no host, so it cannot be
    // told apart from the base's own entry for the id — replacing moves Cmd+J recency permanently.
    const partitions = {
      local: session({
        tabsByWorktree: {},
        lastVisitedAtByWorktreeId: { [WORKTREE_ID]: 1000 }
      } as unknown as WorkspaceSessionState),
      [SSH_HOST_ID]: session({
        tabsByWorktree: { [WORKTREE_ID]: [] },
        lastVisitedAtByWorktreeId: { [WORKTREE_ID]: 9999 }
      } as unknown as WorkspaceSessionState)
    }

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(partitions as never),
      repos
    )

    expect(read.session.lastVisitedAtByWorktreeId?.[WORKTREE_ID]).toBe(1000)
  })

  it('still adopts a host-qualified recency key, which names its own owner', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({
          tabsByWorktree: {},
          lastVisitedAtByWorktreeId: { [WORKTREE_ID]: 1000 }
        } as unknown as WorkspaceSessionState),
        [SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [] },
          lastVisitedAtByWorktreeId: { [`${SSH_HOST_ID}|${WORKTREE_ID}`]: 9999 }
        } as unknown as WorkspaceSessionState)
      } as never),
      repos
    )

    expect(read.session.lastVisitedAtByWorktreeId?.[`${SSH_HOST_ID}|${WORKTREE_ID}`]).toBe(9999)
    expect(read.session.lastVisitedAtByWorktreeId?.[WORKTREE_ID]).toBe(1000)
  })
})

describe('ssh host partition write/read round trip', () => {
  /** The two halves pinned together through the shipping write path. Testing the read against a
   *  hand-built partition is what let an editor-only workspace fall out: the fixture asserted the
   *  shape the read expected instead of the shape the write actually produces. */
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
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(partitions as never),
      repos
    )
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
      } as unknown as WorkspaceSessionState)
    )

    expect(restored.openFilesByWorktree?.[WORKTREE_ID]?.[0]?.dirtyDraftContent).toBe(
      'work in progress'
    )
    expect(restored.activeTabTypeByWorktree?.[WORKTREE_ID]).toBe('editor')
  })

  it('sends a terminal SSH workspace to its partition and reads it back', async () => {
    const restored = await roundTrip(
      session({ tabsByWorktree: { [WORKTREE_ID]: [tab('tab-live')] } })
    )

    expect(restored.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['tab-live'])
  })
})

describe('ssh host partition and the closed-last-terminal tombstone', () => {
  /** Two readings of one value meet here. The terminal layer writes an explicit empty
   *  `tabsByWorktree` row to mean "the user closed the last terminal" and reserves an ABSENT row for
   *  "never initialized" — a real tombstone, honoured by `shouldAutoCreateInitialTerminal`. This
   *  adoption reads an empty row on the BASE side as a gap to fill. Opposite readings, same value,
   *  so the boundary between them is asserted rather than reasoned about: a mature product ships
   *  exactly this defect, with a correct write side and one reader that decides seeding on a count
   *  and never consults the record. */
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
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(partitions as never),
      repos
    )
    return { restored: read.session, partitions }
  }

  it('writes an SSH workspace emptied by this build into the partition that owns it', async () => {
    // The precondition the whole non-recurrence claim rests on: the tombstone lands in
    // `ssh:<targetId>` and `local` keeps no row, so the legacy shape cannot be regenerated.
    const { partitions } = await roundTripSession(
      session({ tabsByWorktree: { [WORKTREE_ID]: [] } })
    )

    expect(partitions[SSH_HOST_ID]?.tabsByWorktree?.[WORKTREE_ID]).toEqual([])
    expect(Object.hasOwn(partitions.local?.tabsByWorktree ?? {}, WORKTREE_ID)).toBe(false)
  })

  it('restores that tombstone as an explicit empty row, not a deleted key', async () => {
    // A deleted key reads back as "never initialized" and the workspace re-seeds on every launch,
    // which is the defect the tombstone exists to prevent. Presence is the whole signal.
    const { restored } = await roundTripSession(session({ tabsByWorktree: { [WORKTREE_ID]: [] } }))

    expect(Object.hasOwn(restored.tabsByWorktree, WORKTREE_ID)).toBe(true)
    expect(restored.tabsByWorktree[WORKTREE_ID]).toEqual([])
  })

  it('leaves the restored workspace un-seeded by the shared seeding predicate', async () => {
    // Asserted through the real predicate rather than by inspecting the row, because the row being
    // right is worth nothing if the reader that acts on it disagrees.
    const { restored } = await roundTripSession(session({ tabsByWorktree: { [WORKTREE_ID]: [] } }))

    expect(
      shouldAutoCreateInitialTerminal(
        restored.tabsByWorktree[WORKTREE_ID]?.length ?? 0,
        Object.hasOwn(restored.tabsByWorktree, WORKTREE_ID)
      )
    ).toBe(false)
  })

  it('does not adopt a stale populated ssh row over a tombstone in the owning partition', async () => {
    // The collision stated directly. The tombstone is in `ssh:<targetId>` — where this build writes
    // it — and adoption must neither hand stale tabs back nor read the row as a gap.
    const partitions = {
      local: session({ tabsByWorktree: {} }),
      [SSH_HOST_ID]: session({ tabsByWorktree: { [WORKTREE_ID]: [] } })
    }
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(partitions as never),
      repos
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(Object.hasOwn(read.session.tabsByWorktree, WORKTREE_ID)).toBe(true)
  })

  it('resurrects the legacy-transition shape exactly once and not again', async () => {
    // The documented knownGap, and the claim that makes it acceptable. Boot 1 adopts the stranded
    // tabs back over `local`'s empty row — non-destructive, and the repair working. The user then
    // empties the workspace on THIS build, and boot 2 must hold the tombstone: the row now lives in
    // the owning partition and `local` no longer names the workspace, so there is nothing left to
    // resurrect from. A gap that recurred would be a permanent re-seed, not a one-shot.
    const firstBoot = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({ tabsByWorktree: { [WORKTREE_ID]: [] } }),
        [SSH_HOST_ID]: session({ tabsByWorktree: { [WORKTREE_ID]: [tab('tab-stale')] } })
      } as never),
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

  it('publishes the tombstone rather than a row the host can read as unknown', async () => {
    // Rule 3, client-publishes -> other-client-reads. An emptied workspace must publish its empty
    // list so a paired client sees the same state; the merge's `hostUnknown` defence covers tabs
    // this client holds, and an empty row is exactly what it holds here.
    const { restored } = await roundTripSession(session({ tabsByWorktree: { [WORKTREE_ID]: [] } }))
    const published = exportRemoteWorkspaceSession(restored, {
      isTargetWorktree: (worktreeId) => worktreeId === WORKTREE_ID
    })

    expect(published.tabsByWorktreePath[WORKTREE_PATH]).toEqual([])
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

  it('keeps the tabs when an older client publishes an empty list for them', async () => {
    // Rule 3 skew, the dangerous direction: a client that predates this fix still reads only the
    // local partition, so its own `replace-session` names this workspace's path with NO tabs. The
    // merge already refuses to delete what the host has never been told about — but only for tabs
    // this client actually holds, which before the fix it did not. Hydrating them is what arms
    // that defence, and this client then republishes the real list and repairs the snapshot.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(strandedPartitions([tab('tab-runtime')])),
      repos
    )
    const publishedByOldClient = importRemoteWorkspaceSession(
      {
        activeWorktreePath: null,
        activeTabId: null,
        tabsByWorktreePath: { [WORKTREE_PATH]: [] },
        terminalLayoutsByTabId: {}
      },
      {
        resolveWorktreeId: (worktreePath) => (worktreePath === WORKTREE_PATH ? WORKTREE_ID : null),
        executionHostId: SSH_HOST_ID
      }
    )

    const merged = mergeDirectSshRemoteWorkspaceSession(
      read.session,
      publishedByOldClient,
      new Set([WORKTREE_ID]),
      read.session.tabsByWorktree,
      new Set(),
      SSH_HOST_ID,
      2
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
