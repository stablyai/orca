import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoConnection } from '../../../../shared/workspace-session-terminal-buffers'
import { captureNewlyParkedTerminalTabs } from './parked-terminal-tab-capture-episodes'
import { shutdownBufferCaptures } from './shutdown-buffer-captures'

const REMOTE_REPO: RepoConnection = { id: 'repo', connectionId: 'conn-1', executionHostId: null }
const LOCAL_REPO: RepoConnection = { id: 'repo', connectionId: null, executionHostId: 'local' }
const WORKTREE_ID = 'repo::/repo/worktree'

const storeState: { repos: RepoConnection[] } = { repos: [REMOTE_REPO] }

vi.mock('../../store', () => ({
  useAppStore: { getState: () => storeState }
}))

afterEach(() => {
  shutdownBufferCaptures.clear()
  storeState.repos = [REMOTE_REPO]
})

describe('captureNewlyParkedTerminalTabs', () => {
  it('serializes a newly parked remote tab once per park episode', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    const ledger = new Set<string>()

    captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)
    captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)

    expect(capture).toHaveBeenCalledTimes(1)
    // Why localOnly: the per-tab park is the every-hide cadence, so its bytes must stay off the upload.
    expect(capture).toHaveBeenCalledWith({ includeLocalBuffers: false, localOnly: true })
    expect(ledger).toEqual(new Set(['tab-1']))
  })

  it('re-captures after a reveal, because the replay releases the stored copy', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    const ledger = new Set<string>()

    captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)
    captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(), ledger)
    expect(ledger.size).toBe(0)
    captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)

    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('retries a tab whose pane had no registered capture and captures the rest', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    const ledger = new Set<string>()

    captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1', 'tab-remounting']), ledger)
    expect(ledger).toEqual(new Set(['tab-1']))

    const lateCapture = vi.fn()
    shutdownBufferCaptures.set('tab-remounting', lateCapture)
    captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1', 'tab-remounting']), ledger)

    expect(capture).toHaveBeenCalledTimes(1)
    expect(lateCapture).toHaveBeenCalledTimes(1)
  })

  it('leaves a local worktree alone — its daemon history is the authoritative copy', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    storeState.repos = [LOCAL_REPO]
    const ledger = new Set<string>()

    captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)

    expect(capture).not.toHaveBeenCalled()
    expect(ledger).toEqual(new Set(['tab-1']))
  })
})
