import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'

const { runtimeState, setWatch } = vi.hoisted(() => ({
  runtimeState: { environmentId: null as string | null },
  setWatch: vi.fn(async () => {})
}))
let cleanup: (() => void) | undefined

vi.mock('@/runtime/runtime-git-client', () => ({
  setRuntimeGitStatusUpstreamRefWatch: setWatch
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => null
}))

vi.mock('./file-explorer-runtime-owner', () => ({
  getRightSidebarWorktreeRuntimeSettings: () => ({
    activeRuntimeEnvironmentId: runtimeState.environmentId
  })
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react')
  return {
    ...actual,
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      cleanup = effect() ?? undefined
    }
  }
})

import { useGitStatusUpstreamRefWatch } from './use-git-status-upstream-ref-watch'

describe('useGitStatusUpstreamRefWatch', () => {
  beforeEach(() => {
    setWatch.mockClear()
    runtimeState.environmentId = null
    cleanup = undefined
  })

  it('clears a local binding with the runtime scope that created it', () => {
    useGitStatusUpstreamRefWatch({
      enabled: true,
      executionHostId: 'local',
      worktreeId: 'repo-1::/repo',
      worktreePath: '/repo'
    })

    runtimeState.environmentId = 'runtime-1'
    cleanup?.()

    expect(setWatch).toHaveBeenCalledWith(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'repo-1::/repo',
        worktreePath: '/repo',
        connectionId: undefined
      },
      { executionHostId: 'local' }
    )
  })

  it('publishes the accepted branch and upstream display identity', () => {
    const publish = useGitStatusUpstreamRefWatch({
      enabled: true,
      executionHostId: 'ssh:ssh-1',
      worktreeId: 'repo-1::/repo',
      worktreePath: '/repo'
    })

    publish({
      entries: [],
      conflictOperation: 'unknown',
      branch: 'refs/heads/feature/local',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'team/fork/feature/local',
        ahead: 0,
        behind: 0
      }
    })

    expect(setWatch).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'repo-1::/repo', worktreePath: '/repo' }),
      {
        executionHostId: 'ssh:ssh-1',
        branch: 'refs/heads/feature/local',
        upstreamName: 'team/fork/feature/local'
      }
    )
  })
})
