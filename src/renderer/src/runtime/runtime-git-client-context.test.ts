import { describe, expect, it } from 'vitest'
import { resolveLocalWorktreePath } from './runtime-git-client-context'

const localTarget = { kind: 'local' as const }

describe('resolveLocalWorktreePath', () => {
  it('keeps nested git roots under the registered worktree', () => {
    expect(
      resolveLocalWorktreePath({
        target: localTarget,
        worktreeId: 'repo-id::/workspace/lesspaper',
        worktreePath: '/workspace/lesspaper/.worktrees/001/theme-a'
      })
    ).toBe('/workspace/lesspaper/.worktrees/001/theme-a')
  })

  it('remaps mismatched paths back to the registered worktree', () => {
    expect(
      resolveLocalWorktreePath({
        target: localTarget,
        worktreeId: 'repo-id::/workspace/lesspaper',
        worktreePath: '/tmp/unrelated'
      })
    ).toBe('/workspace/lesspaper')
  })
})
