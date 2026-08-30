/**
 * The removal preflight rescans and re-enriches every confirmed row, so it also
 * recomputes `dirty-editor-buffer` between the user's confirmation and the
 * delete. That verdict used to be dropped on the floor: the workspace was
 * removed with no disclosure. It is the costliest of the family — a terminal can
 * be restarted, but unsaved editor text cannot be recovered once the worktree is
 * gone.
 *
 * Every case asserts the outcome the user sees — the workspace still existing
 * (`removeWorktree` never called) and a failure row explaining why — never an
 * intermediate blocker field.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupBlocker,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

const UNSAVED_EDITOR_MESSAGE =
  'This workspace has unsaved editor changes that deleting it would discard permanently. Review it before removing.'

type UnsavedWorkArm = {
  blocker: WorkspaceCleanupBlocker
  summary: string
  message: string
  /** Local state that makes preflight enrichment recompute this arm's blocker. */
  state: Partial<AppState>
}

const OPEN_FILE_ID = '/tmp/old-workspace/notes.md'

const UNSAVED_WORK_ARMS: UnsavedWorkArm[] = [
  {
    blocker: 'dirty-editor-buffer',
    summary: 'an editor buffer holds unsaved text',
    message: UNSAVED_EDITOR_MESSAGE,
    state: {
      openFiles: [
        { id: OPEN_FILE_ID, worktreeId: WORKTREE_ID, isDirty: true }
      ] as unknown as AppState['openFiles']
    }
  },
  {
    // The other producer path: text kept only in a draft, never flagged dirty.
    blocker: 'dirty-editor-buffer',
    summary: 'an editor draft holds unsaved text',
    message: UNSAVED_EDITOR_MESSAGE,
    state: {
      openFiles: [
        { id: OPEN_FILE_ID, worktreeId: WORKTREE_ID, isDirty: false }
      ] as unknown as AppState['openFiles'],
      editorDrafts: { [OPEN_FILE_ID]: 'unsaved text' } as unknown as AppState['editorDrafts']
    }
  }
]

function installStoreFor(arm: UnsavedWorkArm, approvedBlockers: WorkspaceCleanupBlocker[]) {
  // The rescan replays the same clean row main published; the verdict below is
  // recomputed locally by preflight enrichment.
  const scan = vi.fn().mockResolvedValue({
    scannedAt: NOW,
    candidates: [makeCandidate()],
    errors: []
  } satisfies WorkspaceCleanupScanResult)
  // An idle shell on every probe shape, so no liveness verdict can stand in for
  // the one under test.
  installWorkspaceCleanupApi(scan, vi.fn().mockResolvedValue(null), {
    inspectProcess: vi
      .fn()
      .mockResolvedValue({ foregroundProcess: 'zsh', hasChildProcesses: false }),
    hasChildProcesses: vi.fn().mockResolvedValue(false),
    getForegroundProcess: vi.fn().mockResolvedValue('zsh')
  })
  const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
  const store = createCleanupTestStore(removeWorktree)
  store.setState(arm.state as Partial<AppState> as AppState)
  return { store, removeWorktree, approvedCandidate: makeCandidate({ blockers: approvedBlockers }) }
}

describe('workspace cleanup removal when the preflight finds unsaved editor work', () => {
  for (const arm of UNSAVED_WORK_ARMS) {
    it(`keeps the workspace and tells the user when ${arm.summary}`, async () => {
      const { store, removeWorktree, approvedCandidate } = installStoreFor(arm, [])

      const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [approvedCandidate]
      })

      // The outcome the user sees: the workspace survives, and the summary says why.
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(result.removedIds).toEqual([])
      expect(result.failures).toEqual([
        {
          worktreeId: WORKTREE_ID,
          executionHostId: 'local',
          displayName: 'old-workspace',
          message: arm.message
        }
      ])
    })

    it(`still removes the workspace when the user confirmed a row already showing ${arm.blocker} and ${arm.summary}`, async () => {
      const { store, removeWorktree, approvedCandidate } = installStoreFor(arm, [arm.blocker])

      const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [approvedCandidate]
      })

      // Consent given against this exact verdict is still consent.
      expect(removeWorktree).toHaveBeenCalledTimes(1)
      expect(result.removedIds).toEqual([WORKTREE_ID])
      expect(result.failures).toEqual([])
    })
  }

  it('reports the unsaved editor text, not the running terminal, when both are found', async () => {
    // Ordering is only observable when two verdicts fire at once: a terminal can
    // be restarted, so the message names the loss that is permanent.
    const scan = vi.fn().mockResolvedValue({
      scannedAt: NOW,
      candidates: [makeCandidate()],
      errors: []
    } satisfies WorkspaceCleanupScanResult)
    installWorkspaceCleanupApi(scan, vi.fn().mockResolvedValue(null), {
      inspectProcess: vi
        .fn()
        .mockResolvedValue({ foregroundProcess: 'codex', hasChildProcesses: true }),
      hasChildProcesses: vi.fn().mockResolvedValue(true),
      getForegroundProcess: vi.fn().mockResolvedValue('codex')
    })
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)
    store.setState({
      openFiles: [
        { id: OPEN_FILE_ID, worktreeId: WORKTREE_ID, isDirty: true }
      ] as unknown as AppState['openFiles'],
      tabsByWorktree: {
        [WORKTREE_ID]: [{ id: 'tab-1', title: 'zsh' }] as AppState['tabsByWorktree'][string]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    } as Partial<AppState> as AppState)

    const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(result.failures).toEqual([
      {
        worktreeId: WORKTREE_ID,
        executionHostId: 'local',
        displayName: 'old-workspace',
        message: UNSAVED_EDITOR_MESSAGE
      }
    ])
  })
})
