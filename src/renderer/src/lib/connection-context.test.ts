import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/types'
import { useAppStore } from '@/store'
import { getConnectionId } from './connection-context'

const initialState = useAppStore.getInitialState()

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: '/home/neil/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

describe('getConnectionId', () => {
  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('resolves SSH targets from composite worktree IDs before worktree discovery completes', () => {
    useAppStore.setState({
      repos: [
        makeRepo({
          id: 'repo-ssh',
          connectionId: 'ssh-1'
        })
      ],
      worktreesByRepo: {}
    })

    expect(getConnectionId('repo-ssh::/home/neil/repo-feature')).toBe('ssh-1')
  })

  it('returns null for known local repos without a discovered worktree', () => {
    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-local' })],
      worktreesByRepo: {}
    })

    expect(getConnectionId('repo-local::/Users/me/repo-feature')).toBeNull()
  })

  it('returns undefined when neither the worktree nor repo is known', () => {
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {}
    })

    expect(getConnectionId('repo-missing::/tmp/repo-feature')).toBeUndefined()
  })
})
