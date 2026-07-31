import { describe, expect, it, vi } from 'vitest'

import type { Repo } from '../../../../shared/types'
import { setNonOrcaWorktreeKindVisibility } from './non-orca-worktree-switch-actions'

const SCRATCH_PATH = '/repo/.claude/worktrees/scratch-1'
const EXTERNAL_PATH = '/elsewhere/manual'
function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#000000',
    addedAt: Date.UTC(2026, 4, 24),
    externalWorktreeVisibility: 'hide',
    externalWorktreeVisibilityPromptDismissedAt: 1,
    importedExternalWorktreePaths: [SCRATCH_PATH, EXTERNAL_PATH],
    ...overrides
  }
}

const repo = makeRepo()

function detectedWith(paths: { path: string; scratch: boolean; visible?: boolean }[]) {
  return {
    repoId: 'repo-1',
    authoritative: true as const,
    source: 'git' as const,
    worktrees: paths.map((entry, index) => ({
      id: `repo-1::${entry.path}`,
      repoId: 'repo-1',
      path: entry.path,
      displayName: `w${index}`,
      branch: 'refs/heads/x',
      head: 'abc',
      isBare: false,
      isMainWorktree: false,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      ownership: entry.scratch ? 'agent-scratch' : 'external',
      selectedCheckout: false,
      visible: entry.visible ?? false
    }))
  } as never
}

const detected = detectedWith([
  { path: SCRATCH_PATH, scratch: true, visible: true },
  { path: EXTERNAL_PATH, scratch: false, visible: true }
])

describe('non-Orca worktree switch actions', () => {
  it('drops only the imports of the kind being hidden', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const fetchWorktrees = vi.fn().mockResolvedValue(true)
    const setSwitchState = vi.fn()

    await setNonOrcaWorktreeKindVisibility({
      repo,
      detected,
      kind: 'agent-scratch',
      next: 'hide',
      previous: 'show',
      setSwitchState,
      updateRepo,
      fetchWorktrees
    })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', {
      agentWorktreeVisibility: 'hide',
      importedExternalWorktreePaths: [EXTERNAL_PATH],
      externalWorktreeInboxBaselinePaths: [SCRATCH_PATH]
    })
    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', { requireAuthoritative: true })
    expect(setSwitchState).toHaveBeenLastCalledWith(null)
  })

  it('re-enables discovery when the other kind switches back to shown', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const setSwitchState = vi.fn()

    await setNonOrcaWorktreeKindVisibility({
      repo,
      detected,
      kind: 'other',
      next: 'show',
      previous: 'hide',
      setSwitchState,
      updateRepo,
      fetchWorktrees: vi.fn().mockResolvedValue(true)
    })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', {
      externalWorktreeVisibility: 'show',
      externalWorktreeDiscoverySuppressedAt: null
    })
  })

  it('restores the switch and the import list when the refresh fails', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const setSwitchState = vi.fn()

    await setNonOrcaWorktreeKindVisibility({
      repo,
      detected,
      kind: 'other',
      next: 'hide',
      previous: 'show',
      setSwitchState,
      updateRepo,
      fetchWorktrees: vi.fn().mockResolvedValue(false)
    })

    expect(updateRepo).toHaveBeenNthCalledWith(2, 'repo-1', {
      externalWorktreeVisibility: 'show',
      importedExternalWorktreePaths: [SCRATCH_PATH, EXTERNAL_PATH],
      externalWorktreeInboxBaselinePaths: []
    })
    expect(setSwitchState).toHaveBeenLastCalledWith({
      pending: false,
      error: 'Could not change worktree visibility. Try again.'
    })
  })

  it('reports the failure without touching worktrees when the update is refused', async () => {
    const updateRepo = vi.fn().mockResolvedValue(false)
    const fetchWorktrees = vi.fn()
    const setSwitchState = vi.fn()

    await setNonOrcaWorktreeKindVisibility({
      repo,
      detected,
      kind: 'agent-scratch',
      next: 'show',
      previous: 'hide',
      setSwitchState,
      updateRepo,
      fetchWorktrees
    })

    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(setSwitchState).toHaveBeenLastCalledWith({
      pending: false,
      error: 'Could not change agent scratch worktree visibility. Try again.'
    })
  })

  it('records the paths it hides so the inbox stops re-announcing them', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)

    await setNonOrcaWorktreeKindVisibility({
      repo: makeRepo({ importedExternalWorktreePaths: [], externalWorktreeInboxBaselinePaths: [] }),
      detected: detectedWith([{ path: SCRATCH_PATH, scratch: true }]),
      kind: 'agent-scratch',
      next: 'hide',
      previous: 'show',
      setSwitchState: vi.fn(),
      updateRepo,
      fetchWorktrees: vi.fn().mockResolvedValue(true)
    })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', {
      agentWorktreeVisibility: 'hide',
      importedExternalWorktreePaths: [],
      externalWorktreeInboxBaselinePaths: [SCRATCH_PATH]
    })
  })

  it('answers the first-run question when the other switch is used', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)

    await setNonOrcaWorktreeKindVisibility({
      repo: makeRepo({ externalWorktreeVisibilityPromptDismissedAt: undefined }),
      detected,
      kind: 'other',
      next: 'show',
      previous: 'hide',
      setSwitchState: vi.fn(),
      updateRepo,
      fetchWorktrees: vi.fn().mockResolvedValue(true)
    })

    expect(updateRepo.mock.calls[1][1]).toEqual({
      externalWorktreeVisibilityPromptDismissedAt: expect.any(Number)
    })
  })

  it('leaves the first-run question unanswered when the flip is rolled back', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)

    await setNonOrcaWorktreeKindVisibility({
      repo: makeRepo({ externalWorktreeVisibilityPromptDismissedAt: undefined }),
      detected,
      kind: 'other',
      next: 'show',
      previous: 'hide',
      setSwitchState: vi.fn(),
      updateRepo,
      fetchWorktrees: vi.fn().mockResolvedValue(false)
    })

    expect(
      updateRepo.mock.calls.some(
        (call) => call[1].externalWorktreeVisibilityPromptDismissedAt !== undefined
      )
    ).toBe(false)
  })

  it('refuses to hide a kind against a snapshot that is not authoritative', async () => {
    // Why: the purge and the ledger both read that list, and a fallback scan lists
    // nothing, so acting on it drops the wrong imports and records no decision at all.
    const updateRepo = vi.fn().mockResolvedValue(true)
    const fetchWorktrees = vi.fn()
    const setSwitchState = vi.fn()

    await setNonOrcaWorktreeKindVisibility({
      repo,
      detected: {
        repoId: 'repo-1',
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: []
      } as never,
      kind: 'other',
      next: 'hide',
      previous: 'show',
      setSwitchState,
      updateRepo,
      fetchWorktrees
    })

    expect(updateRepo).not.toHaveBeenCalled()
    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(setSwitchState).toHaveBeenLastCalledWith({
      pending: false,
      error: 'Could not change worktree visibility. Try again.'
    })
  })

  it('still shows a kind when the snapshot is not authoritative, since nothing is purged', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)

    await setNonOrcaWorktreeKindVisibility({
      repo,
      detected: undefined,
      kind: 'agent-scratch',
      next: 'show',
      previous: 'hide',
      setSwitchState: vi.fn(),
      updateRepo,
      fetchWorktrees: vi.fn().mockResolvedValue(true)
    })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { agentWorktreeVisibility: 'show' })
  })

  it('puts back a discovery opt-out that the forward write cleared', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)

    await setNonOrcaWorktreeKindVisibility({
      repo: makeRepo({ externalWorktreeDiscoverySuppressedAt: 1720000000000 }),
      detected,
      kind: 'other',
      next: 'show',
      previous: 'hide',
      setSwitchState: vi.fn(),
      updateRepo,
      fetchWorktrees: vi.fn().mockResolvedValue(false)
    })

    expect(updateRepo.mock.calls[0][1].externalWorktreeDiscoverySuppressedAt).toBeNull()
    expect(updateRepo.mock.calls[1][1].externalWorktreeDiscoverySuppressedAt).toBe(1720000000000)
  })
})
