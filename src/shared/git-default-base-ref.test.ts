import { describe, expect, it, vi } from 'vitest'
import { isRepoDefaultBranch, resolveDefaultBaseRefViaExec } from './git-default-base-ref'

function gitWith(outputs: Record<string, string | Error>) {
  return vi.fn(async (argv: string[]) => {
    const value = outputs[argv.join(' ')]
    if (value instanceof Error) {
      throw value
    }
    if (value === undefined) {
      throw new Error(`unmocked: ${argv.join(' ')}`)
    }
    return { stdout: value }
  })
}

const NO_REFS = {
  'symbolic-ref --quiet refs/remotes/origin/HEAD': new Error('not a symbolic ref'),
  'rev-parse --verify --quiet refs/remotes/origin/main': new Error('missing'),
  'rev-parse --verify --quiet refs/remotes/origin/master': new Error('missing'),
  'rev-parse --verify --quiet refs/heads/main': new Error('missing'),
  'rev-parse --verify --quiet refs/heads/master': new Error('missing')
}

describe('resolveDefaultBaseRefViaExec', () => {
  it('prefers a verified origin/HEAD target', async () => {
    const git = gitWith({
      'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/develop\n',
      'rev-parse --verify --quiet refs/remotes/origin/develop': 'abc123\n'
    })
    await expect(resolveDefaultBaseRefViaExec(git)).resolves.toBe('origin/develop')
  })

  it('falls back to the probe order when origin/HEAD is unset', async () => {
    const git = gitWith({
      ...NO_REFS,
      'rev-parse --verify --quiet refs/heads/main': 'abc123\n'
    })
    await expect(resolveDefaultBaseRefViaExec(git)).resolves.toBe('main')
  })
})

describe('isRepoDefaultBranch', () => {
  it('protects the branch origin/HEAD points at', async () => {
    const git = gitWith({
      'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/develop\n',
      'rev-parse --verify --quiet refs/remotes/origin/develop': 'abc123\n'
    })
    await expect(isRepoDefaultBranch(git, 'develop')).resolves.toBe(true)
    await expect(isRepoDefaultBranch(git, 'refs/heads/develop')).resolves.toBe(true)
  })

  it('does not protect a branch merely named main when the default is another branch', async () => {
    // Why: hardcoding main/master would make an ordinary workspace branch undeletable.
    const git = gitWith({
      'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/develop\n',
      'rev-parse --verify --quiet refs/remotes/origin/develop': 'abc123\n'
    })
    await expect(isRepoDefaultBranch(git, 'main')).resolves.toBe(false)
  })

  it('protects main when it is what the probes resolve', async () => {
    const git = gitWith({
      ...NO_REFS,
      'rev-parse --verify --quiet refs/remotes/origin/main': 'abc123\n'
    })
    await expect(isRepoDefaultBranch(git, 'main')).resolves.toBe(true)
  })

  it('falls back to init.defaultBranch when no ref resolves', async () => {
    const git = gitWith({ ...NO_REFS, 'config --get init.defaultBranch': 'trunk\n' })
    await expect(isRepoDefaultBranch(git, 'trunk')).resolves.toBe(true)
    await expect(isRepoDefaultBranch(git, 'feature/x')).resolves.toBe(false)
  })

  it('protects nothing when every probe fails', async () => {
    const git = gitWith({ ...NO_REFS, 'config --get init.defaultBranch': new Error('unset') })
    await expect(isRepoDefaultBranch(git, 'feature/x')).resolves.toBe(false)
  })

  it('never protects an empty branch name', async () => {
    const git = gitWith({})
    await expect(isRepoDefaultBranch(git, '')).resolves.toBe(false)
    expect(git).not.toHaveBeenCalled()
  })
})
