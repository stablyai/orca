import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoConnection } from '../../../../../../shared/workspace-session/workspace-session-terminal-buffers'
import { captureParkedTerminalBuffers } from './parked-terminal-buffer-capture'
import { shutdownBufferCaptures } from '../../snapshots/shutdown-buffer-captures'

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

  it('yields an ordinary remote park and reports full coverage', async () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)

    await expect(
      captureParkedTerminalBuffers({
        worktreeId: 'repo::/repo/worktree',
        tabIds: ['tab-1'],
        repos: [SSH_REPO],
        localOnly: true
      })
    ).resolves.toBe(true)
    expect(capture).toHaveBeenCalledWith({
      includeLocalBuffers: false,
      localOnly: true,
      yieldBetweenPanes: true
    })
  })

  it('reports an incomplete episode when a tab has no registered capture', async () => {
    shutdownBufferCaptures.set('tab-1', vi.fn())

    await expect(
      captureParkedTerminalBuffers({
        worktreeId: 'repo::/repo/worktree',
        tabIds: ['tab-1', 'tab-mid-remount'],
        repos: [SSH_REPO],
        localOnly: true
      })
    ).resolves.toBe(false)
  })
})
