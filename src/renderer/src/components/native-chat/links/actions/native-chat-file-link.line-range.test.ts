import { describe, expect, it } from 'vitest'
import { resolveNativeChatFileLink } from './native-chat-file-link'

describe('resolveNativeChatFileLink line ranges', () => {
  it('opens a terminal-style line range at its starting line', () => {
    expect(
      resolveNativeChatFileLink('fakesnow/cursor.py:447-464', {
        worktreeId: 'wt-1',
        worktreePath: '/repo/worktree',
        runtimeEnvironmentId: null
      })
    ).toEqual({
      absolutePath: '/repo/worktree/fakesnow/cursor.py',
      line: 447,
      column: null
    })
  })
})
