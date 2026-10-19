import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildHostIdByWorktreeId } from '../../lib/workspace-session-host-persistence'
import { withoutConvertedSshHostRows } from './converted-ssh-host-rows'

const SSH_HOST = 'ssh:target-1' as const
const WORKTREE_ID = 'repo-1::/srv/app'

describe('dropping a converted SSH host from the renderer', () => {
  it('keeps routing its leftover session rows to the host partition, never to local', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only id and host fields.
    const repo = { id: 'repo-1', connectionId: 'target-1' } as Repo
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only id, repoId and hostId.
    const worktree = { id: WORKTREE_ID, repoId: 'repo-1', hostId: SSH_HOST } as unknown as Worktree
    const before = {
      repos: [repo],
      worktreesByRepo: { 'repo-1': [worktree] },
      detectedWorktreesByRepo: {},
      contestedPrimaryHostBySessionKey: {}
    }
    expect(buildHostIdByWorktreeId(before)(WORKTREE_ID)).toBe(SSH_HOST)

    const after = { ...before, ...withoutConvertedSshHostRows(before, 'target-1') }
    expect(after.repos).toEqual([])
    // The terminal tabs it still holds must not land in 'local' as moved source state.
    expect(buildHostIdByWorktreeId(after)(WORKTREE_ID)).toBe(SSH_HOST)
  })

  it.each([
    ['local', 'local' as const, SSH_HOST],
    ['the same host', SSH_HOST, SSH_HOST],
    ['a runtime host', 'runtime:env-1' as const, 'runtime:env-1']
  ])(
    'repins a boot primary of %s unless the server already owns it',
    (_label, primary, expected) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only id and host fields.
      const repo = { id: 'repo-1', connectionId: 'target-1' } as Repo
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only id, repoId and hostId.
      const worktree = {
        id: WORKTREE_ID,
        repoId: 'repo-1',
        hostId: SSH_HOST
      } as unknown as Worktree
      const before = {
        repos: [repo],
        worktreesByRepo: { 'repo-1': [worktree] },
        detectedWorktreesByRepo: {},
        contestedPrimaryHostBySessionKey: { [WORKTREE_ID]: primary }
      }
      const after = { ...before, ...withoutConvertedSshHostRows(before, 'target-1') }
      expect(after.contestedPrimaryHostBySessionKey[WORKTREE_ID]).toBe(expected)
    }
  )
})
