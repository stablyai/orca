import { create } from 'zustand'
import { vi } from 'vitest'
import type { AppState } from '../types'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { createWorkspaceCleanupSlice } from './workspace-cleanup'

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

export function makeState(overrides: Partial<AppState> = {}): AppState {
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

export function createCleanupTestStore(removeWorktree: ReturnType<typeof vi.fn> = vi.fn()) {
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

export function installWorkspaceCleanupApi(scan: ReturnType<typeof vi.fn>) {
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
