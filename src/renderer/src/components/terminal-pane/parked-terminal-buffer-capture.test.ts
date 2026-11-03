import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoConnection } from '../../../../shared/workspace-session-terminal-buffers'
import {
  beginParkedCapturePass,
  captureParkedTerminalBuffers,
  enqueueParkedTerminalCapture,
  whenParkedCaptureSettles
} from './parked-terminal-buffer-capture'
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

  it('routes an ordinary park to the local-only home and reports full coverage', async () => {
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

  it('keeps a force-park capture in the shared layout so a second desktop can cold-restore', async () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)

    await captureParkedTerminalBuffers({
      worktreeId: 'repo::/repo/worktree',
      tabIds: ['tab-1'],
      repos: [SSH_REPO],
      localOnly: false
    })

    expect(capture).toHaveBeenCalledWith({
      includeLocalBuffers: false,
      localOnly: false,
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

describe('parked capture pass generation', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((next) => {
      resolve = next
    })
    return { promise, resolve }
  }

  it('keeps the newer pass when an older overlapping capture settles last', async () => {
    const generation = { current: 0 }
    const commits: string[] = []
    const capturedParked = new Set<string>()

    const older = beginParkedCapturePass(generation)
    const olderCapture = deferred<boolean>()
    const olderPending: Promise<unknown>[] = []
    enqueueParkedTerminalCapture(
      olderCapture.promise,
      () => {
        capturedParked.add('wt-old')
      },
      olderPending,
      older.isCurrent
    )
    whenParkedCaptureSettles(
      Promise.all(olderPending),
      () => {
        commits.push('old')
      },
      older.isCurrent
    )

    const newer = beginParkedCapturePass(generation)
    const newerCapture = deferred<boolean>()
    const newerPending: Promise<unknown>[] = []
    enqueueParkedTerminalCapture(
      newerCapture.promise,
      () => {
        capturedParked.add('wt-new')
      },
      newerPending,
      newer.isCurrent
    )
    whenParkedCaptureSettles(
      Promise.all(newerPending),
      () => {
        commits.push('new')
      },
      newer.isCurrent
    )

    newerCapture.resolve(true)
    await vi.waitFor(() => expect(commits).toEqual(['new']))
    olderCapture.resolve(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(commits).toEqual(['new'])
    expect(capturedParked).toEqual(new Set(['wt-new']))
  })
})
