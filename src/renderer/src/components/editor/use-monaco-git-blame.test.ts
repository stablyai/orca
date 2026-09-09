import { describe, expect, it } from 'vitest'
import type { GitBlameRange } from '../../../../shared/git-blame'
import { findGitBlameRangeForLine, formatGitBlameInlineLabel } from './git-blame-current-line'
import { RuntimeRpcCallError } from '../../runtime/runtime-rpc-client'
import { getGitBlameErrorMessage } from './git-blame-errors'

const range: GitBlameRange = {
  startLine: 4,
  endLine: 8,
  commitId: 'a'.repeat(40),
  author: 'Rafa Alguthami',
  authorEmail: 'rafa@example.com',
  authoredAt: 1_725_235_200,
  summary: 'Add schema'
}

describe('current-line Git blame', () => {
  it('finds only the range containing the caret line', () => {
    expect(findGitBlameRangeForLine([range], 6)).toBe(range)
    expect(findGitBlameRangeForLine([range], 3)).toBeNull()
    expect(findGitBlameRangeForLine([range], 9)).toBeNull()
  })

  it('formats committed and uncommitted annotations', () => {
    expect(formatGitBlameInlineLabel(range)).toContain('Rafa Alguthami')
    expect(formatGitBlameInlineLabel(range)).toContain('Add schema')
    expect(formatGitBlameInlineLabel({ ...range, commitId: null })).toBe('Uncommitted')
  })

  it('explains that an older paired runtime needs to reconnect', () => {
    const error = new RuntimeRpcCallError({
      id: 'blame-request',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: git.blame' }
    })

    expect(getGitBlameErrorMessage(error)).toBe(
      'Git blame is unavailable on this host. Reconnect to update Orca, then try again.'
    )
  })

  it('explains that an older SSH host needs to reconnect through Electron IPC', () => {
    const error = new Error(
      "Error invoking remote method 'git:blame': Error: Git blame is unavailable on this host. Reconnect to update Orca."
    )

    expect(getGitBlameErrorMessage(error)).toBe(
      'Git blame is unavailable on this host. Reconnect to update Orca, then try again.'
    )
  })
})
