import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoConnection } from '../../../../shared/workspace-session-terminal-buffers'
import { captureParkedTerminalBuffers } from './parked-terminal-buffer-capture'
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

describe('captureParkedTerminalBuffers', () => {
  it('skips the capture for a local-repo worktree so a stored buffer survives the park', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)

    const captured = captureParkedTerminalBuffers({
      worktreeId: 'repo::/repo/worktree',
      tabIds: ['tab-1'],
      repos: [LOCAL_REPO],
      localOnly: true
    })

    expect(captured).toBe(true)
    expect(capture).not.toHaveBeenCalled()
  })

  it('routes an ordinary park to the local-only home and reports full coverage', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)

    const captured = captureParkedTerminalBuffers({
      worktreeId: 'repo::/repo/worktree',
      tabIds: ['tab-1'],
      repos: [SSH_REPO],
      localOnly: true
    })

    expect(captured).toBe(true)
    expect(capture).toHaveBeenCalledWith({ includeLocalBuffers: false, localOnly: true })
  })

  it('keeps a force-park capture in the shared layout so a second desktop can cold-restore', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)

    captureParkedTerminalBuffers({
      worktreeId: 'repo::/repo/worktree',
      tabIds: ['tab-1'],
      repos: [SSH_REPO],
      localOnly: false
    })

    expect(capture).toHaveBeenCalledWith({ includeLocalBuffers: false, localOnly: false })
  })

  it('reports an incomplete episode when a tab has no registered capture', () => {
    shutdownBufferCaptures.set('tab-1', vi.fn())

    const captured = captureParkedTerminalBuffers({
      worktreeId: 'repo::/repo/worktree',
      tabIds: ['tab-1', 'tab-mid-remount'],
      repos: [SSH_REPO],
      localOnly: true
    })

    expect(captured).toBe(false)
  })
})
