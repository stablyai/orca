import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoConnection } from '../../../../shared/workspace-session-terminal-buffers'
import { captureForceParkedWorktreeBuffers } from './force-park-buffer-capture'
import { shutdownBufferCaptures } from './shutdown-buffer-captures'

const LOCAL_REPO: RepoConnection = {
  id: 'repo',
  connectionId: null,
  executionHostId: 'local'
}
const SSH_REPO: RepoConnection = {
  id: 'repo',
  connectionId: 'conn-1',
  executionHostId: null
}

afterEach(() => {
  shutdownBufferCaptures.clear()
})

describe('captureForceParkedWorktreeBuffers', () => {
  it('skips the capture for a local-repo worktree so a stored buffer survives force-park', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)

    const captured = captureForceParkedWorktreeBuffers({
      worktreeId: 'repo::/repo/worktree',
      tabIds: ['tab-1'],
      repos: [LOCAL_REPO]
    })

    expect(captured).toBe(true)
    expect(capture).not.toHaveBeenCalled()
  })

  it('captures remote worktree tabs without local buffers and reports full coverage', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)

    const captured = captureForceParkedWorktreeBuffers({
      worktreeId: 'repo::/repo/worktree',
      tabIds: ['tab-1'],
      repos: [SSH_REPO]
    })

    expect(captured).toBe(true)
    expect(capture).toHaveBeenCalledWith({ includeLocalBuffers: false })
  })

  it('reports an incomplete episode when a tab has no registered capture', () => {
    shutdownBufferCaptures.set('tab-1', vi.fn())

    const captured = captureForceParkedWorktreeBuffers({
      worktreeId: 'repo::/repo/worktree',
      tabIds: ['tab-1', 'tab-mid-remount'],
      repos: [SSH_REPO]
    })

    expect(captured).toBe(false)
  })
})
