import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyWorktreeForceDeleteReason } from './removal'

const directories: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Removal Test',
      '-c',
      'user.email=removal@example.test',
      '-c',
      'commit.gpgsign=false',
      ...args
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C', GIT_TERMINAL_PROMPT: '0' }
    }
  )
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('submodule removal with real Git', () => {
  it('requires explicit force even when clean parent status hides a local submodule commit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-submodule-removal-'))
    directories.push(directory)
    git(directory, 'init', 'dependency')
    const source = join(directory, 'dependency')
    writeFileSync(join(source, 'file.txt'), 'initial\n')
    git(source, 'add', '.')
    git(source, 'commit', '-m', 'Initial dependency')

    git(directory, 'init', 'parent')
    const parent = join(directory, 'parent')
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'dependency')
    git(parent, 'commit', '-am', 'Add dependency')
    const worktree = join(directory, 'worktree')
    git(parent, 'worktree', 'add', '-b', 'feature', worktree)
    git(worktree, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init')

    const dependency = join(worktree, 'dependency')
    writeFileSync(join(dependency, 'file.txt'), 'local unpublished work\n')
    git(dependency, 'commit', '-am', 'Local dependency work')
    git(worktree, 'commit', '-am', 'Record local dependency commit')
    expect(git(worktree, 'status', '--porcelain', '--ignore-submodules=none')).toBe('')
    expect(git(dependency, 'rev-list', '--count', 'HEAD', '--not', '--remotes').trim()).toBe('1')

    let refusal = ''
    try {
      git(parent, 'worktree', 'remove', worktree)
    } catch (error) {
      refusal = String((error as { stderr: string }).stderr)
    }
    expect(classifyWorktreeForceDeleteReason(refusal)).toBe('submodules')
    const registeredPath = worktree.replace(/\\/g, '/')
    expect(git(parent, 'worktree', 'list', '--porcelain').replace(/\\/g, '/')).toContain(
      registeredPath
    )
    expect(git(dependency, 'log', '-1', '--format=%s').trim()).toBe('Local dependency work')

    git(parent, 'worktree', 'remove', '--force', worktree)
    expect(git(parent, 'worktree', 'list', '--porcelain').replace(/\\/g, '/')).not.toContain(
      registeredPath
    )
  })
})
