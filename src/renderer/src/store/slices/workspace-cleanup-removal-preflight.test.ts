import {
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupHostIdentity
} from '../../../../shared/workspace-cleanup-host-identity'
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { WorkspaceCleanupScanResult } from '../../../../shared/workspace-cleanup'
import { enrichWorkspaceCleanupCandidates } from './workspace-cleanup'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  installWorkspaceCleanupApi,
  makeCandidate,
  makeState
} from './workspace-cleanup-slice-test-harness'

describe('workspace cleanup removal and protection', () => {
  it('preflights cleanup removals in one batched scan and deletes nested workspaces globally deepest first', async () => {
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
    const scan = vi.fn(async (args?: { worktreeIds?: string[] }) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        scannedAt: NOW,
        candidates: (args?.worktreeIds ?? []).map((id) => candidateById.get(id)!),
        errors: []
      } satisfies WorkspaceCleanupScanResult
    })
    installWorkspaceCleanupApi(scan)

    const removeWorktree = vi.fn(async (target: { id: string }) => {
      deleteOrder.push(target.id)
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
      removedIdentities: expect.arrayContaining(
        candidates.map((candidate) => getWorkspaceCleanupCandidateIdentity(candidate))
      ),
      failures: []
    })

    // Why: one batched scan covers every selected row; deletes stay serial.
    expect(scan).toHaveBeenCalledTimes(1)
    expect(maxActiveDeletes).toBe(1)
    expect(deleteOrder).toEqual([
      'repo-b::/repo/parent/child',
      'repo-a::/repo/parent',
      'repo-c::/other'
    ])
    // No approvedCandidates here, so there is no confirmed row to qualify: the
    // internal-caller compatibility path leaves the host unqualified.
    expect(removeWorktree).toHaveBeenCalledWith(
      { id: 'repo-c::/other', executionHostId: null },
      true,
      {
        suppressPreservedBranchToast: true
      }
    )
    expect(store.getState().workspaceCleanupScan?.candidates).toEqual([])
  })

  it('returns preserved branches for the cleanup batch summary', async () => {
    const candidate = makeCandidate()
    installWorkspaceCleanupApi(
      vi.fn(async () => ({ scannedAt: NOW, candidates: [candidate], errors: [] }))
    )
    const removeWorktree = vi.fn().mockResolvedValue({
      ok: true,
      preservedBranch: { branchName: 'feature/cleanup', head: 'saved-head' }
    })
    const store = createCleanupTestStore(removeWorktree)
    store.setState({
      workspaceCleanupScan: { scannedAt: NOW, candidates: [candidate], errors: [] }
    } as Partial<AppState>)

    await expect(
      store.getState().removeWorkspaceCleanupCandidates([candidate.worktreeId])
    ).resolves.toEqual({
      removedIds: [candidate.worktreeId],
      removedIdentities: [getWorkspaceCleanupHostIdentity('local', candidate.worktreeId)],
      failures: [],
      preservedBranches: [
        {
          worktreeId: candidate.worktreeId,
          branchName: 'feature/cleanup',
          expectedHead: 'saved-head'
        }
      ]
    })
    expect(removeWorktree).toHaveBeenCalledWith(
      { id: candidate.worktreeId, executionHostId: null },
      false,
      {
        suppressPreservedBranchToast: true
      }
    )
  })

  it('forwards the snapshot batch through each successful removal', async () => {
    const candidate = makeCandidate({ executionHostId: 'ssh:ssh-1' })
    installWorkspaceCleanupApi(
      vi.fn(async () => ({ scannedAt: NOW, candidates: [candidate], errors: [] }))
    )
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    await store.getState().removeWorkspaceCleanupCandidates([candidate.worktreeId], {
      snapshotPruneBatchId: 'batch-1'
    })

    expect(removeWorktree).toHaveBeenCalledWith(
      { id: candidate.worktreeId, executionHostId: null },
      false,
      {
        suppressPreservedBranchToast: true,
        snapshotPruneBatchId: 'batch-1'
      }
    )
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
      removedIdentities: [getWorkspaceCleanupHostIdentity('local', WORKTREE_ID)],
      failures: []
    })
    expect(removeWorktree).toHaveBeenCalledWith({ id: WORKTREE_ID, executionHostId: null }, false, {
      suppressPreservedBranchToast: true
    })
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
        includeAllWorkspaces: true,
        scanId: expect.any(String),
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

    expect(scan).toHaveBeenCalledWith({
      worktreeIds: [WORKTREE_ID],
      scanId: expect.any(String),
      refreshActivity: true
    })
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
        removedIdentities: [getWorkspaceCleanupHostIdentity('local', WORKTREE_ID)],
        failures: []
      }
    )
    expect(removeWorktree).toHaveBeenCalledWith({ id: WORKTREE_ID, executionHostId: null }, false, {
      suppressPreservedBranchToast: true
    })
  })

  it('fails a queued removal that now needs a force the user never approved', async () => {
    const approvedCandidate = makeCandidate({ executionHostId: 'local' })
    const dirtySinceConfirmation = makeCandidate({
      executionHostId: 'local',
      tier: 'review',
      blockers: ['dirty-files'],
      git: { clean: false, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW }
    })
    const scan = vi.fn().mockResolvedValue({
      scannedAt: NOW,
      candidates: [dirtySinceConfirmation],
      errors: []
    } satisfies WorkspaceCleanupScanResult)
    installWorkspaceCleanupApi(scan)
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    await expect(
      store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [approvedCandidate]
      })
    ).resolves.toEqual({
      removedIds: [],
      removedIdentities: [],
      failures: [
        {
          worktreeId: WORKTREE_ID,
          executionHostId: 'local',
          displayName: 'old-workspace',
          message: 'Workspace changed after confirmation. Refresh to review it before removing.'
        }
      ]
    })
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('still force-removes rows whose approved candidate already carried git risk', async () => {
    const approvedCandidate = makeCandidate({
      executionHostId: 'local',
      tier: 'review',
      blockers: ['dirty-files'],
      git: { clean: false, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW }
    })
    const scan = vi.fn().mockResolvedValue({
      scannedAt: NOW,
      candidates: [approvedCandidate],
      errors: []
    } satisfies WorkspaceCleanupScanResult)
    installWorkspaceCleanupApi(scan)
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    await expect(
      store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [approvedCandidate]
      })
    ).resolves.toEqual({
      removedIds: [WORKTREE_ID],
      removedIdentities: [getWorkspaceCleanupHostIdentity('local', WORKTREE_ID)],
      failures: []
    })
    expect(removeWorktree).toHaveBeenCalledWith(
      { id: WORKTREE_ID, executionHostId: 'local' },
      true,
      {
        suppressPreservedBranchToast: true
      }
    )
  })

  it('fails a removal that reveals concrete git risk after an unverified force approval', async () => {
    const approvedCandidate = makeCandidate({
      executionHostId: 'local',
      tier: 'review',
      blockers: ['git-status-error'],
      git: { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null }
    })
    const nowRevealsUnpushed = makeCandidate({
      executionHostId: 'local',
      tier: 'review',
      blockers: ['unpushed-commits'],
      git: { clean: true, upstreamAhead: 3, upstreamBehind: 0, checkedAt: NOW }
    })
    const scan = vi.fn().mockResolvedValue({
      scannedAt: NOW,
      candidates: [nowRevealsUnpushed],
      errors: []
    } satisfies WorkspaceCleanupScanResult)
    installWorkspaceCleanupApi(scan)
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    await expect(
      store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [approvedCandidate]
      })
    ).resolves.toEqual({
      removedIds: [],
      removedIdentities: [],
      failures: [
        {
          worktreeId: WORKTREE_ID,
          executionHostId: 'local',
          displayName: 'old-workspace',
          message: 'Workspace changed after confirmation. Refresh to review it before removing.'
        }
      ]
    })
    expect(removeWorktree).not.toHaveBeenCalled()
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
