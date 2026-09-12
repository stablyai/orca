import { describe, expect, it } from 'vitest'
import {
  createExplicitBareRepositoryReadState,
  explicitBareRepositoryRetryArgs,
  runWithExplicitBareRepositoryRetry
} from './git-bare-repository-command'

describe('explicitBareRepositoryRetryArgs', () => {
  it('retries strict implicit bare-repository failures through the current gitdir', () => {
    const error = Object.assign(new Error('git failed'), {
      stderr: "fatal: cannot use bare repository '/repo.git' (safe.bareRepository is 'explicit')"
    })

    const args = explicitBareRepositoryRetryArgs(['worktree', 'list', '--porcelain'], error)

    expect(args).toEqual(['--git-dir=.', 'worktree', 'list', '--porcelain'])
  })

  it('does not retry unrelated repository failures', () => {
    const error = Object.assign(new Error('git failed'), {
      stderr: 'fatal: not a git repository'
    })

    const args = explicitBareRepositoryRetryArgs(['worktree', 'list'], error)

    expect(args).toBeNull()
  })

  it('does not retry a command that already selected its gitdir', () => {
    const error = Object.assign(new Error('git failed'), {
      stderr: "fatal: cannot use bare repository '/repo.git' (safe.bareRepository is 'explicit')"
    })

    const args = explicitBareRepositoryRetryArgs(['--git-dir=.', 'status'], error)

    expect(args).toBeNull()
  })

  it('finds an explicit gitdir after global options with values', () => {
    const error = Object.assign(new Error('git failed'), {
      stderr: "fatal: cannot use bare repository '/repo.git' (safe.bareRepository is 'explicit')"
    })

    const args = explicitBareRepositoryRetryArgs(
      ['-C', 'repo', '-c', 'core.fsmonitor=false', '--git-dir', '.', 'status'],
      error
    )

    expect(args).toBeNull()
  })

  it.each([
    ['rev-parse', '--git-dir', '--git-common-dir'],
    ['ls-files', '--', '--git-dir=fixture']
  ])('retries when --git-dir appears after the subcommand', (...args) => {
    const error = Object.assign(new Error('git failed'), {
      stderr: "fatal: cannot use bare repository '/repo.git' (safe.bareRepository is 'explicit')"
    })

    const retryArgs = explicitBareRepositoryRetryArgs(args, error)

    expect(retryArgs).toEqual(['--git-dir=.', ...args])
  })

  it('keeps later pathspec reads explicit after a confirmed retry', async () => {
    const state = createExplicitBareRepositoryReadState()
    const calls: string[][] = []
    const run = async (args: string[]): Promise<string> => {
      calls.push(args)
      if (calls.length === 1) {
        throw Object.assign(new Error('git failed'), {
          stderr:
            "fatal: cannot use bare repository '/repo.git' (safe.bareRepository is 'explicit')"
        })
      }
      return 'ok'
    }

    await expect(
      runWithExplicitBareRepositoryRetry(['rev-parse', 'HEAD'], run, state)
    ).resolves.toBe('ok')
    await expect(
      runWithExplicitBareRepositoryRetry(['diff', 'base', 'head'], run, state)
    ).resolves.toBe('ok')

    expect(calls).toEqual([
      ['rev-parse', 'HEAD'],
      ['--git-dir=.', 'rev-parse', 'HEAD'],
      ['--git-dir=.', 'diff', 'base', 'head']
    ])
  })
})
