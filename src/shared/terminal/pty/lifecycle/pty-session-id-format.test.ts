import { describe, expect, it } from 'vitest'
import {
  isPtySessionIdOwnedByWorktree,
  isServeMintedPtySessionId,
  mintServePtySessionId,
  parsePtySessionId
} from './pty-session-id-format'

const UUID = '10000000-0000-4000-8000-0000000000aa'

// The parsers are unchanged since v1.4.243, so released clients read serve ids the same way (#36716).
describe('serve-minted pty session ids', () => {
  it.each([
    ['folder', 'folder:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['POSIX worktree', 'repo-1::/Users/me/src/app:v2/wt'],
    ['SSH worktree', 'repo-ssh::/home/dev/a@b/wt'],
    ['Windows worktree', 'repo-2::C:\\Users\\me\\wt'],
    ['WSL worktree', 'repo-3::\\\\wsl.localhost\\Ubuntu\\home\\me\\wt']
  ])('round-trips a %s workspace id', (_kind, worktreeId) => {
    const id = mintServePtySessionId(worktreeId, UUID)

    expect(parsePtySessionId(id)).toEqual({ worktreeId })
    expect(isServeMintedPtySessionId(id)).toBe(true)
    expect(isPtySessionIdOwnedByWorktree(id, worktreeId)).toBe(true)
    expect(isPtySessionIdOwnedByWorktree(id, `${worktreeId}-sibling`)).toBe(false)
  })

  it('still recognizes the workspace-less ids older hosts minted', () => {
    const legacy = `serve-${UUID}`

    expect(isServeMintedPtySessionId(legacy)).toBe(true)
    expect(parsePtySessionId(legacy)).toEqual({ worktreeId: null })
  })

  it('does not treat a workspace path containing serve- as a serve id', () => {
    expect(isServeMintedPtySessionId('repo::/srv/serve-app@@deadbeef')).toBe(false)
  })
})
