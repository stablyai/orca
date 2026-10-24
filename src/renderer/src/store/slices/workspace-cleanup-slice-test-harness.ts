import type { AgentStatusReadState } from '../agent-status-observers'
import { createTestStore, seedStore } from './store-test-helpers'
import 'zustand'
import { vi } from 'vitest'

import {
  applyWorkspaceCleanupPolicy,
  type WorkspaceCleanupCandidate
} from '../../../../shared/workspace-cleanup'
import './workspace-cleanup'

export const WORKTREE_ID = 'repo1::/tmp/old-workspace'
export const NOW = 1_700_000_000_000

export function makeCandidate(
  overrides: Partial<WorkspaceCleanupCandidate> = {}
): WorkspaceCleanupCandidate {
  return applyWorkspaceCleanupPolicy({
    worktreeId: WORKTREE_ID,
    repoId: 'repo1',
    repoName: 'Repo 1',
    connectionId: null,
    // Why: main host-qualifies every candidate it builds; removal fails closed without it (STA-4343).
    executionHostId: 'local',
    displayName: 'old-workspace',
    branch: 'old-workspace',
    path: '/tmp/old-workspace',
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
  })
}

export function makeState(overrides: Partial<AgentStatusReadState> = {}): AgentStatusReadState {
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
  } as AgentStatusReadState
}

export function createCleanupTestStore(
  removeWorktree: AgentStatusReadState['removeWorktree'] = vi.fn<
    AgentStatusReadState['removeWorktree']
  >()
) {
  const store = createTestStore()
  seedStore(store, { removeWorktree })
  return store
}

export function installWorkspaceCleanupApi(
  scan: ReturnType<typeof vi.fn>,
  getCachedScan: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(null)
) {
  ;(globalThis as { window: unknown }).window = {
    api: {
      workspaceCleanup: {
        scan,
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
