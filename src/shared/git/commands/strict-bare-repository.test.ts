import { describe, expect, it } from 'vitest'
import { strictBareRepositoryRetryArgs } from './strict-bare-repository'

const REFUSAL =
  "fatal: cannot use bare repository '/repos/bare.git' (safe.bareRepository is 'explicit')\n"

describe('strictBareRepositoryRetryArgs', () => {
  it('inserts --git-dir=. once before the subcommand for the exact refusal', () => {
    expect(
      strictBareRepositoryRetryArgs(['worktree', 'list', '--porcelain'], { stderr: REFUSAL })
    ).toEqual(['--git-dir=.', 'worktree', 'list', '--porcelain'])
  })

  it('keeps leading global options ahead of the inserted --git-dir', () => {
    expect(
      strictBareRepositoryRetryArgs(['-C', '/repos/bare.git', 'status'], { stderr: REFUSAL })
    ).toEqual(['-C', '/repos/bare.git', '--git-dir=.', 'status'])
  })

  it('does not retry when --git-dir is already present', () => {
    expect(
      strictBareRepositoryRetryArgs(['--git-dir=.', 'worktree', 'list'], { stderr: REFUSAL })
    ).toBeNull()
    expect(
      strictBareRepositoryRetryArgs(['--git-dir', '.', 'worktree', 'list'], { stderr: REFUSAL })
    ).toBeNull()
  })

  it('does not retry a different failure or a second fatal line', () => {
    expect(
      strictBareRepositoryRetryArgs(['status'], { stderr: 'fatal: not a git repository\n' })
    ).toBeNull()
    expect(
      strictBareRepositoryRetryArgs(['status'], {
        stderr: `${REFUSAL}fatal: this operation must be run in a work tree\n`
      })
    ).toBeNull()
    expect(strictBareRepositoryRetryArgs(['status'], { message: REFUSAL })).toBeNull()
    expect(strictBareRepositoryRetryArgs([], { stderr: REFUSAL })).toBeNull()
  })
})
