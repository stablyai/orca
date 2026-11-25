import { describe, expect, it } from 'vitest'
import { resolveAnnotationPathInsideWorktree } from './check-annotation-path'

describe('resolveAnnotationPathInsideWorktree', () => {
  it('rejects paths that escape or start outside the worktree', () => {
    expect(resolveAnnotationPathInsideWorktree('/repo', '.github')).toBeNull()
    expect(resolveAnnotationPathInsideWorktree('/repo', '../../tmp/secret.txt')).toBeNull()
    expect(resolveAnnotationPathInsideWorktree('/repo', '/tmp/secret.txt')).toBeNull()
    expect(resolveAnnotationPathInsideWorktree('C:\\Repo', 'D:\\secret.txt')).toBeNull()
  })
})
