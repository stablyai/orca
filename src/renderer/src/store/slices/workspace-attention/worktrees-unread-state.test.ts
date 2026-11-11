import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installAttentionScreen } from './workspace-unread-characterization-fixture'
import type { AppState } from '../../types'
import { makeDetectedResult } from '../worktrees/listing/worktrees-detected-listing-fixtures'
import { makeWorktree } from '../worktrees/worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../worktrees/worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

// Why: ghostty "show until interact" — attention raises the dot even on the active worktree; only engagement clears it.
describe('worktree unread (show-until-interact)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('reads a hidden detected worktree once it is activated and on screen', () => {
    const store = createTestStore()
    const hidden = makeWorktree({
      id: 'repo1::/path/hidden',
      repoId: 'repo1',
      path: '/path/hidden',
      isUnread: true
    })
    const detected = makeDetectedResult('repo1', [hidden])
    detected.worktrees[0] = { ...detected.worktrees[0], ownership: 'external', visible: false }
    store.setState({
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: { repo1: detected }
    } as Partial<AppState>)

    installAttentionScreen(store, true)
    store.setState({ activeView: 'settings' })
    store.getState().setActiveWorktree(hidden.id)
    // Settings is not the workspace's own view, so nothing is on screen yet.
    expect(store.getState().detectedWorktreesByRepo.repo1.worktrees[0].isUnread).toBe(true)

    store.setState({ activeView: 'terminal' })

    expect(store.getState().activeWorktreeId).toBe(hidden.id)
    expect(store.getState().detectedWorktreesByRepo.repo1.worktrees[0].isUnread).toBe(false)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: hidden.id,
        updates: { isUnread: false }
      })
    )
  })
})
