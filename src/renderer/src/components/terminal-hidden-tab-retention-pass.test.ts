import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoConnection } from '../../../shared/workspace-session-terminal-buffers'
import { shutdownBufferCaptures } from './terminal-pane/shutdown-buffer-captures'
import { withholdUncapturedRetentionParks } from './terminal-hidden-tab-retention-pass'

const REMOTE_REPO: RepoConnection = { id: 'repo', connectionId: 'conn-1', executionHostId: null }
const LOCAL_REPO: RepoConnection = { id: 'repo', connectionId: null, executionHostId: 'local' }
const WORKTREE_ID = 'repo::/repo/worktree'

const storeState: { repos: RepoConnection[] } = { repos: [REMOTE_REPO] }

vi.mock('../store', () => ({
  useAppStore: { getState: () => storeState }
}))

afterEach(() => {
  shutdownBufferCaptures.clear()
  storeState.repos = [REMOTE_REPO]
})

const owners = (...tabIds: string[]) => new Map(tabIds.map((id) => [id, WORKTREE_ID]))

describe('withholdUncapturedRetentionParks', () => {
  it('captures a newly retention-parked remote tab before publishing it', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)

    const parked = withholdUncapturedRetentionParks(new Set(['tab-1']), new Set(), owners('tab-1'))

    expect(capture).toHaveBeenCalledWith({ includeLocalBuffers: false, localOnly: true })
    expect(parked).toEqual(new Set(['tab-1']))
  })

  it('keeps a tab mounted when its capture is incomplete so a later pass retries', () => {
    const parked = withholdUncapturedRetentionParks(
      new Set(['tab-remounting']),
      new Set(),
      owners('tab-remounting')
    )

    expect(parked.size).toBe(0)
  })

  it('does not re-capture a tab that is already retention-parked', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)

    const parked = withholdUncapturedRetentionParks(
      new Set(['tab-1']),
      new Set(['tab-1']),
      owners('tab-1')
    )

    expect(capture).not.toHaveBeenCalled()
    expect(parked).toEqual(new Set(['tab-1']))
  })

  it('parks a local-worktree tab without serializing it', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    storeState.repos = [LOCAL_REPO]

    const parked = withholdUncapturedRetentionParks(new Set(['tab-1']), new Set(), owners('tab-1'))

    expect(capture).not.toHaveBeenCalled()
    expect(parked).toEqual(new Set(['tab-1']))
  })
})
