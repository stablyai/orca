import { describe, expect, it, vi } from 'vitest'
import { WORKSPACE_CLEANUP_CLASSIFIER_VERSION } from '../../../../shared/workspace-cleanup/workspace-cleanup'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

const LEGACY_DISMISSAL = {
  worktreeId: WORKTREE_ID,
  dismissedAt: NOW,
  fingerprint: 'fingerprint-1',
  classifierVersion: WORKSPACE_CLEANUP_CLASSIFIER_VERSION
}

function seedLegacyDismissalOnTwoHosts() {
  installWorkspaceCleanupApi(vi.fn())
  const store = createCleanupTestStore()
  const local = makeCandidate({ blockers: ['dismissed'] })
  const ssh = makeCandidate({
    executionHostId: 'ssh:ssh-1',
    connectionId: 'ssh-1',
    blockers: ['dismissed']
  })
  store.setState({
    workspaceCleanupDismissals: { [WORKTREE_ID]: LEGACY_DISMISSAL },
    workspaceCleanupScan: { scannedAt: NOW, candidates: [local, ssh], errors: [] }
  })
  return { store, local }
}

function dismissedByHost(store: ReturnType<typeof createCleanupTestStore>) {
  return Object.fromEntries(
    (store.getState().workspaceCleanupScan?.candidates ?? []).map((candidate) => [
      candidate.executionHostId,
      candidate.blockers.includes('dismissed')
    ])
  )
}

describe('restoreWorkspaceCleanupCandidates', () => {
  it('keeps a legacy dismissal on the other host when one host stops ignoring', async () => {
    const { store, local } = seedLegacyDismissalOnTwoHosts()

    await store.getState().restoreWorkspaceCleanupCandidates([local])

    expect(window.api.workspaceCleanup.dismiss).toHaveBeenCalledWith({
      dismissals: [{ ...LEGACY_DISMISSAL, executionHostId: 'ssh:ssh-1' }],
      restoredDismissalKeys: [`local\0${WORKTREE_ID}`, WORKTREE_ID]
    })
    expect(Object.keys(store.getState().workspaceCleanupDismissals)).toEqual([
      `ssh:ssh-1\0${WORKTREE_ID}`
    ])
    expect(dismissedByHost(store)).toEqual({ local: false, 'ssh:ssh-1': true })
  })

  it('leaves the row ignored when the dismissal store rejects', async () => {
    const { store, local } = seedLegacyDismissalOnTwoHosts()
    vi.mocked(window.api.workspaceCleanup.dismiss).mockRejectedValueOnce(new Error('disk full'))

    await expect(store.getState().restoreWorkspaceCleanupCandidates([local])).rejects.toThrow(
      'disk full'
    )

    expect(Object.keys(store.getState().workspaceCleanupDismissals)).toEqual([WORKTREE_ID])
    expect(dismissedByHost(store)).toEqual({ local: true, 'ssh:ssh-1': true })
  })
})
