import { describe, expect, it } from 'vitest'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { getActiveWorktreeSshStatus } from './quick-action-context'

const connection = (status: SshConnectionState['status']): SshConnectionState => ({
  targetId: 'box',
  status,
  error: null,
  reconnectAttempt: 0
})

function sshStatus(
  repo: Partial<typeof TEST_REPO> & {
    connectionId?: string
    executionHostId?: 'local' | 'ssh:box'
  },
  worktree: { repoId?: string; hostId?: 'local' | 'ssh:box' },
  status: SshConnectionState['status'] | null = 'disconnected'
) {
  return getActiveWorktreeSshStatus(
    {
      repos: [{ ...TEST_REPO, ...repo }],
      sshConnectionStates: new Map(status ? [['box', connection(status)]] : []),
      worktreesByRepo: {}
    },
    makeWorktree({ id: 'wt', repoId: TEST_REPO.id, ...worktree })
  )
}

describe('active workspace SSH status', () => {
  it('has none for a local workspace', () => {
    expect(sshStatus({ executionHostId: 'local' }, { hostId: 'local' })).toBeNull()
  })

  it('reads a repo that names its SSH target with connectionId', () => {
    expect(sshStatus({ connectionId: 'box' }, {})).toBe('disconnected')
    expect(sshStatus({ connectionId: 'box' }, {}, 'connected')).toBe('connected')
  })

  it('reads a repo owned through its execution host alone', () => {
    expect(sshStatus({ executionHostId: 'ssh:box' }, {})).toBe('disconnected')
    expect(sshStatus({ executionHostId: 'ssh:box' }, {}, 'connected')).toBe('connected')
  })

  it("reads a folder workspace's own SSH host when it has no repo row", () => {
    expect(sshStatus({ id: 'other-repo' }, { hostId: 'ssh:box' })).toBe('disconnected')
    expect(sshStatus({ id: 'other-repo' }, { hostId: 'ssh:box' }, 'connected')).toBe('connected')
  })

  it('treats an SSH host with no known connection as disconnected', () => {
    expect(sshStatus({ executionHostId: 'ssh:box' }, {}, null)).toBe('disconnected')
  })
})
