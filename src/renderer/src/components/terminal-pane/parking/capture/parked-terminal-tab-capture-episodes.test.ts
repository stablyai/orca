import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoConnection } from '../../../../../../shared/workspace-session/workspace-session-terminal-buffers'
import { captureNewlyParkedTerminalTabs } from './parked-terminal-tab-capture-episodes'
import { shutdownBufferCaptures } from '../../snapshots/shutdown-buffer-captures'

const REMOTE_REPO: RepoConnection = { id: 'repo', connectionId: 'conn-1', executionHostId: null }
const LOCAL_REPO: RepoConnection = { id: 'repo', connectionId: null, executionHostId: 'local' }
const WORKTREE_ID = 'repo::/repo/worktree'

const storeState: { repos: RepoConnection[] } = { repos: [REMOTE_REPO] }

vi.mock('../../../../store/index', () => ({
  useAppStore: { getState: () => storeState }
}))

afterEach(() => {
  shutdownBufferCaptures.clear()
  storeState.repos = [REMOTE_REPO]
})

describe('captureNewlyParkedTerminalTabs', () => {
  it('serializes a newly parked remote tab once and yields between panes', async () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    const ledger = new Set<string>()

    await captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)
    await captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)

    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith({
      includeLocalBuffers: false,
      localOnly: true,
      yieldBetweenPanes: true
    })
    expect(ledger).toEqual(new Set(['tab-1']))
  })

  it('leaves a local worktree alone so its daemon history stays authoritative', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    storeState.repos = [LOCAL_REPO]
    const ledger = new Set<string>()

    captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)

    expect(capture).not.toHaveBeenCalled()
    expect(ledger).toEqual(new Set(['tab-1']))
  })
})
