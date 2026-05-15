/* eslint-disable max-lines -- Why: cleanup store tests share a Zustand store
   harness and mocked window API; splitting would obscure the state transitions. */
import { create } from 'zustand'
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupCandidate,
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

describe('workspace cleanup viewed rows', () => {
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

    expect(scan).toHaveBeenCalledWith({
      skipGitWorktreeIds: expect.arrayContaining([WORKTREE_ID, 'repo1::/tmp/terminal-workspace'])
    })
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
