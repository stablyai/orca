/**
 * STA-4343 (list state): two hosts publishing the same `repoId::path` row must
 * stay two rows. Before the fix the streamed-progress merge, the dismissal
 * match, and the post-removal prune all keyed on `worktreeId` alone, so one
 * host's row silently replaced — or silently hid, or silently dropped — the
 * other's, which is what let a user confirm a row that was not the one shown.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupHostIdentity,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../shared/workspace-cleanup-host-identity'
import {
  shouldHideWorkspaceCleanupCandidate,
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupDismissal
} from '../../../../shared/workspace-cleanup'
import { resolveWorkspaceCleanupRemovalTargets } from './workspace-cleanup-removal-targets'
import type { AppState } from '../types'
import { createTestStore, seedStore } from './store-test-helpers'

const dismissMock = vi.fn().mockResolvedValue(undefined)

// @ts-expect-error -- minimal window.api stub for dismissal persistence
globalThis.window = { api: { workspaceCleanup: { dismiss: dismissMock } } }

const WORKTREE_ID = 'repo1::/shared/workspace'

function makeCandidate(
  executionHostId: WorkspaceCleanupCandidate['executionHostId'],
  connectionId: string | null = null
): WorkspaceCleanupCandidate {
  return {
    worktreeId: WORKTREE_ID,
    repoId: 'repo1',
    repoName: 'Repo 1',
    connectionId,
    ...(executionHostId ? { executionHostId } : {}),
    displayName: 'shared-workspace',
    branch: 'old',
    path: '/shared/workspace',
    tier: 'ready',
    selectedByDefault: true,
    reasons: ['idle-clean'],
    blockers: [],
    lastActivityAt: 0,
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      retainedDoneAgentCount: 0
    },
    git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 },
    fingerprint: 'fp-1'
  }
}

function makeDismissal(
  executionHostId?: WorkspaceCleanupDismissal['executionHostId']
): WorkspaceCleanupDismissal {
  return {
    worktreeId: WORKTREE_ID,
    dismissedAt: 0,
    fingerprint: 'fp-1',
    classifierVersion: WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
    ...(executionHostId ? { executionHostId } : {})
  }
}

describe('workspace cleanup host-qualified identity', () => {
  it('separates two hosts publishing the same worktree id', () => {
    const local = makeCandidate('local')
    const remote = makeCandidate('ssh:ssh-1', 'ssh-1')
    expect(getWorkspaceCleanupCandidateIdentity(local)).not.toBe(
      getWorkspaceCleanupCandidateIdentity(remote)
    )
    expect(getWorkspaceCleanupCandidateIdentity(remote)).toBe(
      getWorkspaceCleanupHostIdentity('ssh:ssh-1', WORKTREE_ID)
    )
  })

  it('reports no removal host for a row with no host evidence', () => {
    expect(resolveWorkspaceCleanupRemovalHostId(makeCandidate(undefined))).toBeNull()
    // A pre-executionHostId remote row still names its connection.
    expect(resolveWorkspaceCleanupRemovalHostId(makeCandidate(undefined, 'ssh-1'))).toBe(
      'ssh:ssh-1'
    )
  })
})

describe('workspace cleanup dismissals', () => {
  it('hides only the dismissed host row', () => {
    const dismissal = makeDismissal('ssh:ssh-1')
    expect(
      shouldHideWorkspaceCleanupCandidate(makeCandidate('ssh:ssh-1', 'ssh-1'), dismissal)
    ).toBe(true)
    expect(shouldHideWorkspaceCleanupCandidate(makeCandidate('local'), dismissal)).toBe(false)
  })

  it('keeps a legacy id-only dismissal hiding its row', () => {
    expect(shouldHideWorkspaceCleanupCandidate(makeCandidate('local'), makeDismissal())).toBe(true)
  })

  it('stores same-id dismissals independently and still reads a legacy id-only key', async () => {
    const local = makeCandidate('local')
    const remote = makeCandidate('ssh:ssh-1', 'ssh-1')
    const store = createTestStore()
    seedStore(store, {
      workspaceCleanupScan: { scannedAt: 1, candidates: [local, remote], errors: [] }
    } as Partial<AppState>)

    await store.getState().dismissWorkspaceCleanupCandidates([local, remote])

    expect(Object.keys(store.getState().workspaceCleanupDismissals).sort()).toEqual(
      [
        getWorkspaceCleanupCandidateIdentity(local),
        getWorkspaceCleanupCandidateIdentity(remote)
      ].sort()
    )
    expect(store.getState().workspaceCleanupScan?.candidates).toEqual([
      expect.objectContaining({ blockers: expect.arrayContaining(['dismissed']) }),
      expect.objectContaining({ blockers: expect.arrayContaining(['dismissed']) })
    ])

    seedStore(store, {
      workspaceCleanupDismissals: { [WORKTREE_ID]: makeDismissal() },
      workspaceCleanupScan: { scannedAt: 1, candidates: [local], errors: [] }
    } as Partial<AppState>)
    await store.getState().dismissWorkspaceCleanupCandidates([])

    expect(store.getState().workspaceCleanupScan?.candidates[0]?.blockers).toContain('dismissed')
  })
})

describe('workspace cleanup removal targets', () => {
  const emptyState = { worktreesByRepo: {}, detectedWorktreesByRepo: {} } as unknown as AppState

  it('carries the confirmed host through as the removal owner', () => {
    const [target] = resolveWorkspaceCleanupRemovalTargets([WORKTREE_ID], emptyState, {
      approvedCandidates: [makeCandidate('ssh:ssh-1', 'ssh-1')]
    })
    expect(target).toMatchObject({ kind: 'target', executionHostId: 'ssh:ssh-1' })
  })

  it('fails closed when one id is confirmed for two hosts at once', () => {
    const [target] = resolveWorkspaceCleanupRemovalTargets([WORKTREE_ID], emptyState, {
      approvedCandidates: [makeCandidate('local'), makeCandidate('ssh:ssh-1', 'ssh-1')]
    })
    expect(target?.kind).toBe('unresolved')
  })

  it('fails closed for a confirmed row with no host evidence despite one known owner', () => {
    const state = {
      worktreesByRepo: { repo1: [{ id: WORKTREE_ID, repoId: 'repo1', hostId: 'ssh:ssh-1' }] },
      detectedWorktreesByRepo: {}
    } as unknown as AppState
    const [target] = resolveWorkspaceCleanupRemovalTargets([WORKTREE_ID], state, {
      approvedCandidates: [makeCandidate(undefined)]
    })
    expect(target?.kind).toBe('unresolved')
  })

  it('fails closed for a confirmed row when no owner row carries a host', () => {
    const [target] = resolveWorkspaceCleanupRemovalTargets([WORKTREE_ID], emptyState, {
      approvedCandidates: [makeCandidate(undefined)]
    })
    expect(target?.kind).toBe('unresolved')
  })
})
