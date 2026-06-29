/* eslint-disable max-lines -- Why: cleanup store tests share a Zustand store
   harness and mocked window API; splitting would obscure the state transitions. */
import { create } from 'zustand'
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import { createWorkspaceCleanupSlice, enrichWorkspaceCleanupCandidates } from './workspace-cleanup'

const WORKTREE_ID = 'repo1::/tmp/old-workspace'
const NOW = 1_700_000_000_000

function makeCandidate(
  overrides: Partial<WorkspaceCleanupCandidate> = {}
): WorkspaceCleanupCandidate {
  return {
    worktreeId: WORKTREE_ID,
    repoId: 'repo1',
    repoName: 'Repo 1',
    connectionId: null,
    displayName: 'old-workspace',
    branch: 'old-workspace',
    path: '/tmp/old-workspace',
    tier: 'ready',
    selectedByDefault: true,
    reasons: ['idle-clean'],
    blockers: [],
    lastActivityAt: NOW - 30 * 24 * 60 * 60 * 1000,
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      retainedDoneAgentCount: 0
    },
    git: {
      clean: true,
      upstreamAhead: 0,
      upstreamBehind: 0,
      checkedAt: NOW
    },
    fingerprint: 'fingerprint-1',
    ...overrides
  }
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    openFiles: [],
    editorDrafts: {},
    browserTabsByWorktree: {},
    retainedAgentsByPaneKey: {},
    activeWorktreeId: null,
    agentStatusByPaneKey: {},
    runtimePaneTitlesByTabId: {},
    lastVisitedAtByWorktreeId: {},
    workspaceCleanupDismissals: {},
    workspaceCleanupViewedCandidates: {},
    ...overrides
  } as AppState
}

function createCleanupTestStore(removeWorktree = vi.fn()) {
  return create<AppState>()(
    (...a) =>
      ({
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        openFiles: [],
        editorDrafts: {},
        browserTabsByWorktree: {},
        retainedAgentsByPaneKey: {},
        activeWorktreeId: null,
        agentStatusByPaneKey: {},
        runtimePaneTitlesByTabId: {},
        lastVisitedAtByWorktreeId: {},
        removeWorktree,
        ...createWorkspaceCleanupSlice(...a)
      }) as unknown as AppState
  )
}

function installWorkspaceCleanupApi(scan: ReturnType<typeof vi.fn>) {
  ;(globalThis as { window: unknown }).window = {
    api: {
      workspaceCleanup: {
        scan,
        dismiss: vi.fn().mockResolvedValue(undefined),
        clearDismissals: vi.fn().mockResolvedValue(undefined),
        hasKillableLocalProcesses: vi.fn().mockResolvedValue({
          hasKillableProcesses: false
        })
      }
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

describe('workspace cleanup viewed rows', () => {
  it('joins duplicate broad cleanup scans', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    const scan = vi.fn().mockReturnValue(pending.promise)
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()

    const first = store.getState().scanWorkspaceCleanup()
    const second = store.getState().scanWorkspaceCleanup()

    expect(scan).toHaveBeenCalledTimes(1)
    expect(store.getState().workspaceCleanupLoading).toBe(true)

    const result = { scannedAt: NOW, candidates: [makeCandidate()], errors: [] }
    pending.resolve(result)

    await expect(Promise.all([first, second])).resolves.toEqual([result, result])
    expect(store.getState().workspaceCleanupScan?.candidates).toHaveLength(1)
    expect(store.getState().workspaceCleanupLoading).toBe(false)
  })

  it('does not leave cleanup loading stuck when a reopen joins a just-settled scan', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    const result = { scannedAt: NOW, candidates: [makeCandidate()], errors: [] }
    const scan = vi.fn().mockReturnValue(pending.promise)
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()
    let joinedScan: Promise<WorkspaceCleanupScanResult> | null = null

    const unsubscribe = store.subscribe((state, previousState) => {
      if (
        previousState.workspaceCleanupLoading &&
        !state.workspaceCleanupLoading &&
        joinedScan === null
      ) {
        joinedScan = state.scanWorkspaceCleanup()
      }
    })

    const firstScan = store.getState().scanWorkspaceCleanup()
    pending.resolve(result)

    await expect(firstScan).resolves.toEqual(result)
    await expect(joinedScan).resolves.toEqual(result)
    unsubscribe()

    expect(scan).toHaveBeenCalledTimes(1)
    expect(store.getState().workspaceCleanupLoading).toBe(false)
  })

  it('shows scanned cleanup candidates before the final broad scan resolves', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    const partialCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/partial' })
    const finalCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/final' })
    const scan = vi.fn((_args, progressCallback) => {
      onProgress = progressCallback
      return pending.promise
    })
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()

    const scanPromise = store.getState().scanWorkspaceCleanup()
    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 1,
      totalWorktreeCount: 2,
      candidates: [partialCandidate],
      errors: []
    })

    expect(store.getState().workspaceCleanupLoading).toBe(true)
    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress).toMatchObject({
        scannedWorktreeCount: 1,
        totalWorktreeCount: 2
      })
    })
    expect(store.getState().workspaceCleanupScan?.candidates).toEqual([partialCandidate])

    pending.resolve({
      scannedAt: NOW,
      candidates: [partialCandidate, finalCandidate],
      errors: []
    })

    await expect(scanPromise).resolves.toEqual({
      scannedAt: NOW,
      candidates: [partialCandidate, finalCandidate],
      errors: []
    })
    expect(store.getState().workspaceCleanupLoading).toBe(false)
    expect(store.getState().workspaceCleanupProgress).toMatchObject({
      scannedWorktreeCount: 2,
      totalWorktreeCount: 2
    })
  })

  it('does not re-probe previously enriched rows during cumulative progress updates', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    const terminalCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/terminal' })
    const laterCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/later' })
    const scan = vi.fn((_args, progressCallback) => {
      onProgress = progressCallback
      return pending.promise
    })
    installWorkspaceCleanupApi(scan)
    const hasChildProcesses = vi.fn().mockResolvedValue(false)
    const getForegroundProcess = vi.fn().mockResolvedValue('zsh')
    ;(
      globalThis.window as unknown as {
        api: {
          pty?: {
            hasChildProcesses: typeof hasChildProcesses
            getForegroundProcess: typeof getForegroundProcess
          }
        }
      }
    ).api.pty = { hasChildProcesses, getForegroundProcess }
    const store = createCleanupTestStore()
    store.setState({
      tabsByWorktree: {
        'repo1::/tmp/terminal': [
          { id: 'tab-1', title: 'zsh' }
        ] as AppState['tabsByWorktree'][string]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    } as Partial<AppState>)

    const scanPromise = store.getState().scanWorkspaceCleanup()
    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 1,
      totalWorktreeCount: 2,
      candidates: [terminalCandidate],
      errors: [],
      candidateMode: 'append'
    })

    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(1)
    })
    expect(hasChildProcesses).toHaveBeenCalledTimes(1)
    expect(getForegroundProcess).toHaveBeenCalledTimes(1)

    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 2,
      totalWorktreeCount: 2,
      candidates: [laterCandidate],
      errors: [],
      candidateMode: 'append'
    })

    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(2)
    })
    expect(store.getState().workspaceCleanupScan?.candidates).toHaveLength(2)
    expect(hasChildProcesses).toHaveBeenCalledTimes(1)
    expect(getForegroundProcess).toHaveBeenCalledTimes(1)

    pending.resolve({
      scannedAt: NOW,
      candidates: [terminalCandidate, laterCandidate],
      errors: []
    })
    await scanPromise

    expect(hasChildProcesses).toHaveBeenCalledTimes(1)
    expect(getForegroundProcess).toHaveBeenCalledTimes(1)
  })

  it('does not join broad cleanup scans with different explicit args', async () => {
    const firstPending = deferred<WorkspaceCleanupScanResult>()
    const secondPending = deferred<WorkspaceCleanupScanResult>()
    const firstResult = {
      scannedAt: NOW,
      candidates: [makeCandidate({ worktreeId: 'repo1::/tmp/first' })],
      errors: []
    }
    const secondResult = {
      scannedAt: NOW + 1,
      candidates: [makeCandidate({ worktreeId: 'repo1::/tmp/second' })],
      errors: []
    }
    const scan = vi.fn((args?: { skipGitWorktreeIds?: string[] }) =>
      args?.skipGitWorktreeIds?.includes('repo1::/tmp/first')
        ? firstPending.promise
        : secondPending.promise
    )
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()

    const first = store
      .getState()
      .scanWorkspaceCleanup({ skipGitWorktreeIds: ['repo1::/tmp/first'] })
    const second = store
      .getState()
      .scanWorkspaceCleanup({ skipGitWorktreeIds: ['repo1::/tmp/second'] })

    expect(scan).toHaveBeenCalledTimes(2)
    secondPending.resolve(secondResult)
    await second
    expect(store.getState().workspaceCleanupScan).toMatchObject(secondResult)

    firstPending.resolve(firstResult)
    await expect(Promise.all([first, second])).resolves.toEqual([firstResult, secondResult])
    expect(store.getState().workspaceCleanupScan).toMatchObject(secondResult)
  })

  it('keeps stale cleanup results visible after a broad refresh failure', async () => {
    const previous = { scannedAt: NOW, candidates: [makeCandidate()], errors: [] }
    const scan = vi
      .fn()
      .mockResolvedValueOnce(previous)
      .mockRejectedValueOnce(new Error('scan failed'))
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()

    await store.getState().scanWorkspaceCleanup()
    await expect(store.getState().scanWorkspaceCleanup()).rejects.toThrow('scan failed')

    expect(store.getState().workspaceCleanupScan).toMatchObject(previous)
    expect(store.getState().workspaceCleanupError).toBe('scan failed')
    expect(store.getState().workspaceCleanupLoading).toBe(false)
  })

  it('keeps focused cleanup preflight scans separate from broad scans', async () => {
    const broad = deferred<WorkspaceCleanupScanResult>()
    const scan = vi.fn((args?: { worktreeId?: string }) => {
      if (args?.worktreeId) {
        return Promise.resolve({
          scannedAt: NOW + 1,
          candidates: [makeCandidate({ worktreeId: args.worktreeId })],
          errors: []
        } satisfies WorkspaceCleanupScanResult)
      }
      return broad.promise
    })
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()

    const broadScan = store.getState().scanWorkspaceCleanup()
    const focusedScan = await store.getState().scanWorkspaceCleanup({ worktreeId: WORKTREE_ID })

    expect(scan).toHaveBeenCalledTimes(2)
    expect(focusedScan.candidates[0]?.worktreeId).toBe(WORKTREE_ID)
    expect(store.getState().workspaceCleanupScan).toBeNull()

    broad.resolve({ scannedAt: NOW, candidates: [], errors: [] })
    await broadScan
    expect(store.getState().workspaceCleanupScan?.scannedAt).toBe(NOW)
  })

  it('preflights cleanup removals concurrently and deletes nested workspaces globally deepest first', async () => {
    let activePreflights = 0
    let maxActivePreflights = 0
    let activeDeletes = 0
    let maxActiveDeletes = 0
    const deleteOrder: string[] = []
    const candidates = [
      makeCandidate({
        worktreeId: 'repo-a::/repo/parent',
        repoId: 'repo-a',
        path: '/repo/parent',
        displayName: 'parent'
      }),
      makeCandidate({
        worktreeId: 'repo-b::/repo/parent/child',
        repoId: 'repo-b',
        path: '/repo/parent/child',
        displayName: 'child'
      }),
      makeCandidate({
        worktreeId: 'repo-c::/other',
        repoId: 'repo-c',
        path: '/other',
        displayName: 'other',
        git: { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null },
        blockers: ['git-status-error']
      })
    ]
    const candidateById = new Map(candidates.map((candidate) => [candidate.worktreeId, candidate]))
    const scan = vi.fn(async (args?: { worktreeId?: string }) => {
      activePreflights += 1
      maxActivePreflights = Math.max(maxActivePreflights, activePreflights)
      await new Promise((resolve) => setTimeout(resolve, 5))
      activePreflights -= 1
      return {
        scannedAt: NOW,
        candidates: args?.worktreeId ? [candidateById.get(args.worktreeId)!] : [],
        errors: []
      } satisfies WorkspaceCleanupScanResult
    })
    installWorkspaceCleanupApi(scan)

    const removeWorktree = vi.fn(async (worktreeId: string) => {
      deleteOrder.push(worktreeId)
      activeDeletes += 1
      maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes)
      await new Promise((resolve) => setTimeout(resolve, 5))
      activeDeletes -= 1
      return { ok: true as const }
    })
    const store = createCleanupTestStore(removeWorktree)
    store.setState({
      workspaceCleanupScan: { scannedAt: NOW, candidates, errors: [] }
    } as Partial<AppState>)

    await expect(
      store
        .getState()
        .removeWorkspaceCleanupCandidates(candidates.map((candidate) => candidate.worktreeId))
    ).resolves.toEqual({
      removedIds: expect.arrayContaining(candidates.map((candidate) => candidate.worktreeId)),
      failures: []
    })

    expect(maxActivePreflights).toBeGreaterThan(1)
    expect(maxActiveDeletes).toBe(1)
    expect(deleteOrder).toEqual([
      'repo-b::/repo/parent/child',
      'repo-a::/repo/parent',
      'repo-c::/other'
    ])
    expect(removeWorktree).toHaveBeenCalledWith('repo-c::/other', true)
    expect(store.getState().workspaceCleanupScan?.candidates).toEqual([])
  })

  it('demotes an active suggested workspace when it was not viewed from cleanup', async () => {
    const [candidate] = await enrichWorkspaceCleanupCandidates(
      [makeCandidate()],
      makeState({ activeWorktreeId: WORKTREE_ID }),
      { applyDismissals: false }
    )

    expect(candidate.tier).toBe('protected')
    expect(candidate.blockers).toContain('active-workspace')
  })

  it('keeps a viewed active workspace visible but not removable', async () => {
    const [candidate] = await enrichWorkspaceCleanupCandidates(
      [makeCandidate()],
      makeState({
        activeWorktreeId: WORKTREE_ID,
        workspaceCleanupViewedCandidates: {
          [WORKTREE_ID]: {
            viewedAt: Date.now(),
            fingerprint: 'fingerprint-1',
            wasSuggested: true
          }
        }
      }),
      { applyDismissals: false }
    )

    expect(candidate.tier).toBe('protected')
    expect(candidate.selectedByDefault).toBe(false)
    expect(candidate.blockers).toContain('active-workspace')
  })

  it('does not preserve the cleanup view exception after the row changes', async () => {
    const [candidate] = await enrichWorkspaceCleanupCandidates(
      [makeCandidate({ fingerprint: 'fingerprint-2' })],
      makeState({
        activeWorktreeId: WORKTREE_ID,
        workspaceCleanupViewedCandidates: {
          [WORKTREE_ID]: {
            viewedAt: Date.now(),
            fingerprint: 'fingerprint-1',
            wasSuggested: true
          }
        }
      }),
      { applyDismissals: false }
    )

    expect(candidate.tier).toBe('protected')
    expect(candidate.blockers).toContain('active-workspace')
  })

  it('protects recently visible old workspaces with open context', async () => {
    const [candidate] = await enrichWorkspaceCleanupCandidates(
      [makeCandidate()],
      makeState({
        openFiles: [
          {
            id: 'file-1',
            worktreeId: WORKTREE_ID,
            filePath: '/tmp/old-workspace/src/app.ts',
            relativePath: 'src/app.ts',
            language: 'typescript',
            isDirty: false
          }
        ] as AppState['openFiles'],
        lastVisitedAtByWorktreeId: {
          [WORKTREE_ID]: Date.now()
        }
      }),
      { applyDismissals: false }
    )

    expect(candidate.tier).toBe('protected')
    expect(candidate.selectedByDefault).toBe(false)
    expect(candidate.blockers).toContain('recent-visible-context')
  })

  it('uses current renderer state after async delete preflight scan resolves', async () => {
    let resolveScan: (value: WorkspaceCleanupScanResult) => void
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    ;(globalThis as { window: unknown }).window = {
      api: {
        workspaceCleanup: {
          scan: vi.fn(
            (): Promise<WorkspaceCleanupScanResult> =>
              new Promise<WorkspaceCleanupScanResult>((resolve) => {
                resolveScan = resolve
              })
          ),
          dismiss: vi.fn().mockResolvedValue(undefined),
          clearDismissals: vi.fn().mockResolvedValue(undefined),
          hasKillableLocalProcesses: vi.fn().mockResolvedValue({
            hasKillableProcesses: false
          })
        }
      }
    }

    const removal = store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID])
    store.setState({ activeWorktreeId: WORKTREE_ID })
    resolveScan!({ scannedAt: NOW, candidates: [makeCandidate()], errors: [] })

    await expect(removal).resolves.toEqual({
      removedIds: [WORKTREE_ID],
      failures: []
    })
    expect(removeWorktree).toHaveBeenCalledWith(WORKTREE_ID, false)
  })

  it('defers git checks for locally active workspaces on initial scans', async () => {
    const scan = vi.fn().mockResolvedValue({
      scannedAt: NOW,
      candidates: [],
      errors: []
    } satisfies WorkspaceCleanupScanResult)
    ;(globalThis as { window: unknown }).window = {
      api: {
        workspaceCleanup: {
          scan,
          dismiss: vi.fn().mockResolvedValue(undefined),
          clearDismissals: vi.fn().mockResolvedValue(undefined),
          hasKillableLocalProcesses: vi.fn().mockResolvedValue({
            hasKillableProcesses: false
          })
        }
      }
    }

    const store = createCleanupTestStore()
    store.setState({
      activeWorktreeId: WORKTREE_ID,
      tabsByWorktree: {
        'repo1::/tmp/terminal-workspace': [
          { id: 'tab-1', title: 'zsh' }
        ] as AppState['tabsByWorktree'][string]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    } as Partial<AppState>)

    await store.getState().scanWorkspaceCleanup()

    expect(scan).toHaveBeenCalledWith(
      {
        skipGitWorktreeIds: expect.arrayContaining([WORKTREE_ID, 'repo1::/tmp/terminal-workspace'])
      },
      expect.any(Function)
    )
  })

  it('does not defer git checks for focused remove preflights', async () => {
    const scan = vi.fn().mockResolvedValue({
      scannedAt: NOW,
      candidates: [makeCandidate()],
      errors: []
    } satisfies WorkspaceCleanupScanResult)
    ;(globalThis as { window: unknown }).window = {
      api: {
        workspaceCleanup: {
          scan,
          dismiss: vi.fn().mockResolvedValue(undefined),
          clearDismissals: vi.fn().mockResolvedValue(undefined),
          hasKillableLocalProcesses: vi.fn().mockResolvedValue({
            hasKillableProcesses: false
          })
        }
      }
    }

    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)
    store.setState({ activeWorktreeId: 'repo1::/tmp/other-workspace' } as Partial<AppState>)

    await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID])

    expect(scan).toHaveBeenCalledWith({ worktreeId: WORKTREE_ID })
  })

  it('lets explicitly selected not-suggested workspaces reach the removal path', async () => {
    const scan = vi.fn().mockResolvedValue({
      scannedAt: NOW,
      candidates: [makeCandidate()],
      errors: []
    } satisfies WorkspaceCleanupScanResult)
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    ;(globalThis as { window: unknown }).window = {
      api: {
        workspaceCleanup: {
          scan,
          dismiss: vi.fn().mockResolvedValue(undefined),
          clearDismissals: vi.fn().mockResolvedValue(undefined),
          hasKillableLocalProcesses: vi.fn().mockResolvedValue({
            hasKillableProcesses: true
          })
        }
      }
    }

    const store = createCleanupTestStore(removeWorktree)

    store.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [{ id: 'tab-1', title: 'zsh' }] as AppState['tabsByWorktree'][string]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    } as Partial<AppState>)

    await expect(store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID])).resolves.toEqual(
      {
        removedIds: [WORKTREE_ID],
        failures: []
      }
    )
    expect(removeWorktree).toHaveBeenCalledWith(WORKTREE_ID, false)
  })

  it('protects old workspaces when an agent process is still foregrounded', async () => {
    ;(globalThis as { window: unknown }).window = {
      api: {
        pty: {
          hasChildProcesses: vi.fn().mockResolvedValue(true),
          getForegroundProcess: vi.fn().mockResolvedValue('codex')
        }
      }
    }

    const [candidate] = await enrichWorkspaceCleanupCandidates(
      [makeCandidate()],
      makeState({
        tabsByWorktree: {
          [WORKTREE_ID]: [{ id: 'tab-1', title: 'zsh' }] as AppState['tabsByWorktree'][string]
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] }
      }),
      { applyDismissals: false }
    )

    expect(candidate.tier).toBe('protected')
    expect(candidate.selectedByDefault).toBe(false)
    expect(candidate.blockers).toContain('running-terminal')
  })

  it('does not let an idle title in another tab mask a running agent process', async () => {
    ;(globalThis as { window: unknown }).window = {
      api: {
        pty: {
          hasChildProcesses: vi.fn(async (ptyId: string) => ptyId === 'pty-running'),
          getForegroundProcess: vi.fn(async (ptyId: string) =>
            ptyId === 'pty-running' ? 'codex' : 'zsh'
          )
        }
      }
    }

    const [candidate] = await enrichWorkspaceCleanupCandidates(
      [makeCandidate()],
      makeState({
        tabsByWorktree: {
          [WORKTREE_ID]: [
            { id: 'tab-running', title: 'zsh' },
            { id: 'tab-idle', title: 'Codex done' }
          ] as AppState['tabsByWorktree'][string]
        },
        ptyIdsByTabId: {
          'tab-running': ['pty-running'],
          'tab-idle': ['pty-idle']
        }
      }),
      { applyDismissals: false }
    )

    expect(candidate.tier).toBe('protected')
    expect(candidate.selectedByDefault).toBe(false)
    expect(candidate.blockers).toContain('running-terminal')
  })
})
