/** Restore sessions runtime wrote to SSH partitions, formerly unread by renderer local/runtime-only hydration (#12721/#18173). */
import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
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

/** Reproduce #12721: local has an empty terminal list while SSH owns the real rows. */
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
    // Full SSH writes replace the partition; retain runtime-authored rows during reunification or repair deletes them.
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

  it('ignores a stray local copy of a workspace the catalog places on the ssh target', async () => {
    // Local SSH-workspace rows are residue; retaining them resurrected closed tabs while losing live host rows (#23390/#25616).
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(strandedPartitions([tab('tab-runtime')], [tab('tab-local')])),
      repos
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-runtime'
    ])
    expect(read.session.activeTabIdByWorktree?.[WORKTREE_ID]).toBe('tab-runtime')
    expect(read.contestedPrimaryHostBySessionKey[WORKTREE_ID]).toBe(SSH_HOST_ID)
  })

  it('keeps the ssh partition agent-resume records beside a stray local copy', async () => {
    const partitions = strandedPartitions([tab('tab-runtime')], [tab('tab-local')])
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

    expect(Object.keys(read.session.sleepingAgentSessionsByPaneKey ?? {})).toEqual([
      'tab-runtime:leaf-1'
    ])
  })

  it('keeps local tabs when the ssh partition names the workspace but holds no tabs', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(strandedPartitions([], [tab('tab-local')])),
      repos
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-local'
    ])
  })

  it('ignores a stray local copy when the ssh partition keys its tabs by workspace key', async () => {
    const partitions = strandedPartitions([tab('tab-runtime')], [tab('tab-local')])
    partitions[SSH_HOST_ID] = session({
      tabsByWorktree: { [worktreeWorkspaceKey(WORKTREE_ID)]: [tab('tab-runtime')] }
    })

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)

    expect(
      Object.values(read.session.tabsByWorktree)
        .flat()
        .map((entry) => entry.id)
    ).toEqual(['tab-runtime'])
  })

  it("replaces a stray local copy's records for a tab id the ssh partition shares", async () => {
    // Relay reattach copied tab ids into `local`, so the stale and live rows can share a key.
    const partitions = strandedPartitions([tab('tab-shared')], [tab('tab-shared')])
    const layout = (activeLeafId: string) => ({ root: null, activeLeafId, expandedLeafId: null })
    partitions.local = session({
      ...partitions.local,
      terminalLayoutsByTabId: { 'tab-shared': layout('leaf-stale') }
    })
    partitions[SSH_HOST_ID] = session({
      ...partitions[SSH_HOST_ID],
      terminalLayoutsByTabId: { 'tab-shared': layout('leaf-live') }
    })

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)

    expect(read.session.terminalLayoutsByTabId?.['tab-shared']?.activeLeafId).toBe('leaf-live')
  })

  it("keeps a stray local copy's unsaved draft beside the ssh partition's open files", async () => {
    const openFile = (relativePath: string, dirtyDraftContent?: string) => ({
      filePath: `${WORKTREE_PATH}/${relativePath}`,
      relativePath,
      worktreeId: WORKTREE_ID,
      language: 'typescript',
      ...(dirtyDraftContent === undefined ? {} : { dirtyDraftContent })
    })
    const partitions = strandedPartitions([tab('tab-runtime')], [tab('tab-local')])
    partitions.local = session({
      ...partitions.local,
      openFilesByWorktree: { [WORKTREE_ID]: [openFile('src/main.ts', 'unsaved work')] }
    })
    partitions[SSH_HOST_ID] = session({
      ...partitions[SSH_HOST_ID],
      openFilesByWorktree: { [WORKTREE_ID]: [openFile('src/live.ts')] }
    })

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-runtime'
    ])
    expect(
      read.session.openFilesByWorktree?.[WORKTREE_ID]?.map((file) => [
        file.relativePath,
        file.dirtyDraftContent
      ])
    ).toEqual([
      ['src/live.ts', undefined],
      ['src/main.ts', 'unsaved work']
    ])
  })

  it("keeps a stray local copy's unsaved draft over the ssh partition's clean entry", async () => {
    const file = {
      filePath: `${WORKTREE_PATH}/src/main.ts`,
      relativePath: 'src/main.ts',
      worktreeId: WORKTREE_ID,
      language: 'typescript'
    }
    const partitions = strandedPartitions([tab('tab-runtime')], [tab('tab-local')])
    partitions.local = session({
      ...partitions.local,
      openFilesByWorktree: { [WORKTREE_ID]: [{ ...file, dirtyDraftContent: 'unsaved work' }] }
    })
    partitions[SSH_HOST_ID] = session({
      ...partitions[SSH_HOST_ID],
      openFilesByWorktree: { [WORKTREE_ID]: [file] }
    })

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)

    expect(
      read.session.openFilesByWorktree?.[WORKTREE_ID]?.map((entry) => entry.dirtyDraftContent)
    ).toEqual(['unsaved work'])
  })

  it('leaves a populated local copy alone when the catalog cannot name its owner', async () => {
    // Without a repo row the local copy may be the live one, so the gap-filling rule still applies.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(strandedPartitions([tab('tab-runtime')], [tab('tab-local')])),
      []
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-local'
    ])
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
  /** Editor-only SSH workspaces are valid: no terminal autocreate occurs beside editors, but all their state still belongs in SSH persistence. */
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
          [WORKTREE_ID]: [
            {
              id: 'browser-1',
              worktreeId: WORKTREE_ID,
              label: 'Docs',
              url: 'https://docs.example',
              title: 'Docs',
              loading: false,
              faviconUrl: null,
              canGoBack: false,
              canGoForward: false,
              loadError: null,
              createdAt: 1
            }
          ]
        },
        lastVisitedAtByWorktreeId: { [`${SSH_HOST_ID}|${WORKTREE_ID}`]: 4242 }
      })
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
    // No other channel carries editor state, so losing it here loses user-authored content outright.
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
    // Never-terminal workspaces have no tabsByWorktree key; discover them from other session chrome too.
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
      })
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
  /** Legacy local editor/draft state plus empty SSH rows is adoptable by terminal criteria; replacing populated base editor state with host emptiness would delete user content. */
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
      }),
      [SSH_HOST_ID]: session({
        tabsByWorktree: { [WORKTREE_ID]: [] },
        ...(hostOpenFiles ? { openFilesByWorktree: { [WORKTREE_ID]: [] } } : {})
      })
    }
  }

  it('does not let an empty host row destroy an unsaved draft the base alone holds', async () => {
    // Host absence of editors proves no base deletion; lost dirtyDraftContent cannot be recovered.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(emptyHostRowsOverBaseDraft(true)),
      repos
    )

    expect(read.session.openFilesByWorktree?.[WORKTREE_ID]?.[0]?.dirtyDraftContent).toBe(
      'unsaved work'
    )
  })

  it('still adopts a populated host row over the base leftovers, keeping only their drafts', async () => {
    // Replace when the host has content, preserving base-only unsaved drafts; gating merely on populated base would disable split repair.
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
    })

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)

    expect(
      read.session.openFilesByWorktree?.[WORKTREE_ID]?.map((file) => file.relativePath)
    ).toEqual(['src/host.ts', 'src/main.ts'])
  })

  it('adopts the layout of a tab the host slice names only in unifiedTabs', async () => {
    // Write routing indexes unified-only tabs too; read discovery must match or those tabs never round-trip.
    const partitions = {
      local: session({ tabsByWorktree: {} }),
      [SSH_HOST_ID]: session({
        tabsByWorktree: {},
        unifiedTabs: {
          [WORKTREE_ID]: [
            {
              id: 'tab-unified',
              entityId: 'tab-unified',
              groupId: 'group-1',
              worktreeId: WORKTREE_ID,
              contentType: 'terminal',
              label: 'tab-unified',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'tab-unified': { root: null, activeLeafId: null, expandedLeafId: null }
        }
      })
    }

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)

    expect(read.session.terminalLayoutsByTabId?.['tab-unified']).toBeDefined()
  })
})

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

  it("does not overwrite a contested workspace's own rows with the ssh workspace's", async () => {
    // Read names local primary; replacing its rows with SSH state would persist another workspace’s editor content and destroy drafts.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi(contestedPartitions()),
      contestedRepos
    )

    expect(read.session.openFilesByWorktree?.[WORKTREE_ID]?.[0]?.dirtyDraftContent).toBe(
      'local unsaved work'
    )
  })

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

  it('does not let a legacy bare recency key move another host workspace of the same id', async () => {
    // Only qualified recency keys prove hosts; replacing bare keys could permanently move another claimant’s Cmd+J history.
    const partitions = {
      local: session({
        tabsByWorktree: {},
        lastVisitedAtByWorktreeId: { [WORKTREE_ID]: 1000 }
      }),
      [SSH_HOST_ID]: session({
        tabsByWorktree: { [WORKTREE_ID]: [] },
        lastVisitedAtByWorktreeId: { [WORKTREE_ID]: 9999 }
      })
    }

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)

    expect(read.session.lastVisitedAtByWorktreeId?.[WORKTREE_ID]).toBe(1000)
  })

  it('still adopts a host-qualified recency key, which names its own owner', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({
          tabsByWorktree: {},
          lastVisitedAtByWorktreeId: { [WORKTREE_ID]: 1000 }
        }),
        [SSH_HOST_ID]: session({
          tabsByWorktree: { [WORKTREE_ID]: [] },
          lastVisitedAtByWorktreeId: { [`${SSH_HOST_ID}|${WORKTREE_ID}`]: 9999 }
        })
      }),
      repos
    )

    expect(read.session.lastVisitedAtByWorktreeId?.[`${SSH_HOST_ID}|${WORKTREE_ID}`]).toBe(9999)
    expect(read.session.lastVisitedAtByWorktreeId?.[WORKTREE_ID]).toBe(1000)
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

  it('sends a terminal SSH workspace to its partition and reads it back', async () => {
    const restored = await roundTrip(
      session({ tabsByWorktree: { [WORKTREE_ID]: [tab('tab-live')] } })
    )

    expect(restored.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['tab-live'])
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

  it('writes an SSH workspace emptied by this build into the partition that owns it', async () => {
    // Tombstones must persist only in owning SSH, leaving no local residue that could regenerate legacy repair input.
    const { partitions } = await roundTripSession(
      session({ tabsByWorktree: { [WORKTREE_ID]: [] } })
    )

    expect(partitions[SSH_HOST_ID]?.tabsByWorktree?.[WORKTREE_ID]).toEqual([])
    expect(Object.hasOwn(partitions.local?.tabsByWorktree ?? {}, WORKTREE_ID)).toBe(false)
  })

  it('restores that tombstone as an explicit empty row, not a deleted key', async () => {
    // Presence prevents reseeding; deleting the key means never initialized and recreates terminals on every launch.
    const { restored } = await roundTripSession(session({ tabsByWorktree: { [WORKTREE_ID]: [] } }))

    expect(Object.hasOwn(restored.tabsByWorktree, WORKTREE_ID)).toBe(true)
    expect(restored.tabsByWorktree[WORKTREE_ID]).toEqual([])
  })

  it('leaves the restored workspace un-seeded by the shared seeding predicate', async () => {
    // Assert the real seeding predicate, not row shape alone, so reader disagreement fails.
    const { restored } = await roundTripSession(session({ tabsByWorktree: { [WORKTREE_ID]: [] } }))

    expect(
      shouldAutoCreateInitialTerminal(
        restored.tabsByWorktree[WORKTREE_ID]?.length ?? 0,
        Object.hasOwn(restored.tabsByWorktree, WORKTREE_ID)
      )
    ).toBe(false)
  })

  it('does not adopt a stale populated ssh row over a tombstone in the owning partition', async () => {
    // Owned SSH tombstones must neither resurrect stale tabs nor become adoptable gaps.
    const partitions = {
      local: session({ tabsByWorktree: {} }),
      [SSH_HOST_ID]: session({ tabsByWorktree: { [WORKTREE_ID]: [] } })
    }
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(partitionedApi(partitions), repos)

    expect(read.session.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(Object.hasOwn(read.session.tabsByWorktree, WORKTREE_ID)).toBe(true)
  })

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
