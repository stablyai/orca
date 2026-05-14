import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { enrichWorkspaceCleanupCandidates } from './workspace-cleanup'

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
    reasons: ['pr-merged'],
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
      branchCompareChangedFiles: 0,
      checkedAt: NOW
    },
    prStateCheckedAt: NOW,
    staleEvidence: false,
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

  it('keeps a viewed suggested workspace in cleanup even when it is now active', async () => {
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

    expect(candidate.tier).toBe('ready')
    expect(candidate.selectedByDefault).toBe(true)
    expect(candidate.blockers).not.toContain('active-workspace')
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
})
