// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitConflictOperation } from '../../../../shared/git-status-types'
import { useStaleConflictOperationPolling } from './stale-conflict-operation-poll'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const request = vi.hoisted(() => vi.fn<() => Promise<GitConflictOperation>>())
vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitConflictOperation: request
}))
vi.mock('./worktree-git-owner-target', () => ({
  getWorktreeGitOwnerTarget: () => ({ kind: 'local' })
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))

const worktrees = ['one', 'two'].map((name) => ({
  id: `repo::/repo/${name}`,
  path: `/repo/${name}`,
  repoId: 'repo'
}))
const conflictOperationByWorktree: Record<string, GitConflictOperation> = Object.fromEntries(
  worktrees.map(({ id }) => [id, 'merge'])
)
const repoMap = new Map([['repo', { kind: 'git' as const }]])
const slowTaskBackoff = { idleMultiplier: 1, changeSignalMultiplier: 1, maxIntervalMs: 300_000 }
const setConflictOperation = (): void => {}
const isConnectionReady = (): boolean => true

function HookProbe({ enabled }: { enabled: boolean }): null {
  useStaleConflictOperationPolling({
    enabled,
    activeWorktreeId: null,
    allWorktrees: worktrees,
    repoMap,
    conflictOperationByWorktree,
    setConflictOperation,
    isConnectionReady,
    slowTaskBackoff
  })
  return null
}

describe('useStaleConflictOperationPolling', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    request.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('stops probing remaining worktrees once the effect is retired and the probe rejects', async () => {
    const pending = Promise.withResolvers<GitConflictOperation>()
    request.mockReturnValueOnce(pending.promise)
    await act(async () => root.render(createElement(HookProbe, { enabled: true })))
    expect(request).toHaveBeenCalledTimes(1)

    await act(async () => root.render(createElement(HookProbe, { enabled: false })))
    await act(async () => pending.reject(new Error('Disconnected during probe')))
    await act(async () => vi.advanceTimersByTimeAsync(10_000))

    expect(request).toHaveBeenCalledTimes(1)
  })
})
