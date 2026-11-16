import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { create } from 'zustand'
import { vi } from 'vitest'
import type { AppState } from '../../types'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { createWorkspaceCleanupSlice } from './create-workspace-cleanup-slice'

export const WORKTREE_ID = 'repo1::/tmp/old-workspace'
export const NOW = 1_700_000_000_000

export function makeCandidate(
  overrides: Partial<WorkspaceCleanupCandidate> = {}
): WorkspaceCleanupCandidate {
  return {
    worktreeId: WORKTREE_ID,
    repoId: 'repo1',
    repoName: 'Repo 1',
    connectionId: null,
    // Why: main host-qualifies every candidate it builds; removal fails closed without it (STA-4343).
    executionHostId: 'local',
    displayName: 'old-workspace',
    branch: 'old-workspace',
    path: '/tmp/old-workspace',
    reasons: ['inactive'],
    blockers: [],
    lastActivityAt: NOW - 30 * 24 * 60 * 60 * 1000,
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      finishedAgentCount: 0
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

export function makeState(overrides: Partial<AppState> = {}): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cleanup selectors read only these snapshot fields and the supplied overrides.
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    openFiles: [],
    editorDrafts: {},
    browserTabsByWorktree: {},

    activeWorktreeId: null,
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
    runtimePaneTitlesByTabId: {},
    lastVisitedAtByWorktreeId: {},
    workspaceCleanupDismissals: {},
    workspaceCleanupViewedCandidates: {},
    repos: [],
    runtimeEnvironments: [],
    ...overrides
  } as AppState
}

export function createCleanupTestStore(removeWorktree: ReturnType<typeof vi.fn> = vi.fn()) {
  return create<AppState>()(
    (...a) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this slice fixture supplies the cleanup actions and every snapshot field they read.
      ({
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        openFiles: [],
        editorDrafts: {},
        browserTabsByWorktree: {},

        activeWorktreeId: null,
        agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
        runtimePaneTitlesByTabId: {},
        lastVisitedAtByWorktreeId: {},
        repos: [],
        runtimeEnvironments: [],
        removeWorktree,
        ...createWorkspaceCleanupSlice(...a)
      }) as unknown as AppState
  )
}

export function installWorkspaceCleanupApi(
  scan: ReturnType<typeof vi.fn>,
  getCachedScan: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(null)
) {
  ;(globalThis as { window: unknown }).window = {
    api: {
      workspaceCleanup: {
        scan,
        cancelScan: vi.fn().mockResolvedValue(true),
        getCachedScan,
        dismiss: vi.fn().mockResolvedValue(undefined),
        clearDismissals: vi.fn().mockResolvedValue(undefined)
      }
    }
  }
}

export function deferred<T>(): {
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
