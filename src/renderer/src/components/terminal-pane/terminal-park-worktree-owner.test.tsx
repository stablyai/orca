// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import {
  getTerminalParkWorktreeOwner,
  useTerminalParkWorktreeOwnerState
} from './terminal-park-worktree-owner'

const WORKTREE_ID = 'repo-1::/worktree'

describe('useTerminalParkWorktreeOwnerState', () => {
  let originalState: ReturnType<typeof useAppStore.getState>

  beforeEach(() => {
    originalState = useAppStore.getState()
    useAppStore.setState({
      repos: [{ id: 'repo-1', connectionId: 'ssh-a' } as Repo],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo-1',
            hostId: 'ssh:ssh-a',
            runtimeOwnerEnvironmentId: 'env-a'
          })
        ]
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(originalState, true)
  })

  it('refreshes owner evidence without rerendering for unrelated store writes', () => {
    const { result } = renderHook(() => useTerminalParkWorktreeOwnerState())
    const initialState = result.current
    expect(getTerminalParkWorktreeOwner(result.current, WORKTREE_ID)).toEqual({
      connectionId: 'ssh-a',
      runtimeEnvironmentId: 'env-a'
    })

    act(() => useAppStore.setState({ activeView: 'settings' }))
    expect(result.current).toBe(initialState)

    act(() => useAppStore.setState({ repos: [{ id: 'repo-1', connectionId: 'ssh-b' } as Repo] }))
    expect(result.current).not.toBe(initialState)
    expect(getTerminalParkWorktreeOwner(result.current, WORKTREE_ID).connectionId).toBe('ssh-b')

    act(() =>
      useAppStore.setState({
        worktreesByRepo: {
          'repo-1': [
            makeWorktree({
              id: WORKTREE_ID,
              repoId: 'repo-1',
              hostId: 'ssh:ssh-b',
              runtimeOwnerEnvironmentId: 'env-b'
            })
          ]
        }
      })
    )
    expect(getTerminalParkWorktreeOwner(result.current, WORKTREE_ID)).toEqual({
      connectionId: 'ssh-b',
      runtimeEnvironmentId: 'env-b'
    })
  })
})
