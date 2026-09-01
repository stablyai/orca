import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readGitRebaseProgress } from './git-rebase-progress'

// Real files, not fs mocks: the on-disk shapes are the contract being tested.
let gitDir: string

async function writeState(dirName: string, files: Record<string, string>): Promise<void> {
  const dir = path.join(gitDir, dirName)
  await mkdir(dir, { recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(dir, name), contents, 'utf-8')
  }
}

beforeEach(async () => {
  gitDir = await mkdtemp(path.join(tmpdir(), 'rebase-progress-'))
})

afterEach(async () => {
  await rm(gitDir, { recursive: true, force: true })
})

describe('readGitRebaseProgress — rebase-merge', () => {
  it('reads every field and strips refs/heads/ off the branch', async () => {
    await writeState('rebase-merge', {
      msgnum: '2\n',
      end: '5\n',
      'head-name': 'refs/heads/feature/topic\n',
      onto: 'f5f9deb5e5967498c3b7a2a8ba5842ee6e65b20b\n',
      message: 'add c as mine\n\nbody line\n',
      done: 'pick f5f9deb5e5967498c3b7a2a8ba5842ee6e65b20b # topic: add c as mine\n'
    })

    expect(await readGitRebaseProgress(gitDir)).toEqual({
      headName: 'feature/topic',
      onto: 'f5f9deb5e5967498c3b7a2a8ba5842ee6e65b20b',
      currentStep: 2,
      totalSteps: 5,
      commitSubject: 'add c as mine',
      stoppedBy: 'pick'
    })
  })

  it('maps the last done line command to stoppedBy', async () => {
    await writeState('rebase-merge', {
      done: [
        'pick f5f9deb5e5967498c3b7a2a8ba5842ee6e65b20b # first',
        'edit cdc8a8f9e4ebfa7a67e97f0d2b8e2f6b9dfd0516 # topic commit 2',
        ''
      ].join('\n'),
      message: 'topic commit 2\n'
    })

    expect((await readGitRebaseProgress(gitDir))?.stoppedBy).toBe('edit')
  })

  it('maps a break line to stoppedBy break and omits the subject', async () => {
    await writeState('rebase-merge', {
      done: 'pick f5f9deb5e5967498c3b7a2a8ba5842ee6e65b20b # first\nbreak\n'
    })

    const progress = await readGitRebaseProgress(gitDir)

    expect(progress).toEqual({ stoppedBy: 'break' })
    expect(progress?.commitSubject).toBeUndefined()
  })

  it('maps squash and other todo commands to pick', async () => {
    await writeState('rebase-merge', {
      done: 'squash cdc8a8f9e4ebfa7a67e97f0d2b8e2f6b9dfd0516 # squashed\n'
    })

    expect((await readGitRebaseProgress(gitDir))?.stoppedBy).toBe('pick')
  })

  it('falls back to the done-line subject when message is absent', async () => {
    await writeState('rebase-merge', {
      msgnum: '3',
      end: '4',
      done: 'edit cdc8a8f9e4ebfa7a67e97f0d2b8e2f6b9dfd0516 # topic commit 2\n'
    })

    expect(await readGitRebaseProgress(gitDir)).toEqual({
      currentStep: 3,
      totalSteps: 4,
      commitSubject: 'topic commit 2',
      stoppedBy: 'edit'
    })
  })

  it('parses a done-line subject that has no # separator', async () => {
    await writeState('rebase-merge', {
      done: 'pick cdc8a8f9e4ebfa7a67e97f0d2b8e2f6b9dfd0516 topic commit 2\n'
    })

    expect((await readGitRebaseProgress(gitDir))?.commitSubject).toBe('topic commit 2')
  })

  it('omits stoppedBy when done is empty', async () => {
    await writeState('rebase-merge', { done: '\n\n', 'head-name': 'refs/heads/main\n' })

    expect(await readGitRebaseProgress(gitDir)).toEqual({ headName: 'main' })
  })

  it('omits both step fields when msgnum/end are missing', async () => {
    await writeState('rebase-merge', {
      'head-name': 'refs/heads/main\n',
      onto: 'deadbeef',
      message: 'still going\n'
    })

    const progress = await readGitRebaseProgress(gitDir)

    expect(progress?.currentStep).toBeUndefined()
    expect(progress?.totalSteps).toBeUndefined()
    expect(progress).toEqual({ headName: 'main', onto: 'deadbeef', commitSubject: 'still going' })
  })

  it.each(['abc', '', '-1', '1.5'])(
    'omits both step fields when msgnum is %j',
    async (msgnum: string) => {
      await writeState('rebase-merge', { msgnum, end: '5', 'head-name': 'refs/heads/main' })

      const progress = await readGitRebaseProgress(gitDir)

      expect(progress?.currentStep).toBeUndefined()
      expect(progress?.totalSteps).toBeUndefined()
    }
  )

  it('omits a detached HEAD head-name', async () => {
    await writeState('rebase-merge', { 'head-name': 'detached HEAD\n', onto: 'deadbeef' })

    expect(await readGitRebaseProgress(gitDir)).toEqual({ onto: 'deadbeef' })
  })
})

describe('readGitRebaseProgress — rebase-apply', () => {
  it('reads next/last/final-commit and never reports stoppedBy', async () => {
    await writeState('rebase-apply', {
      next: '1\n',
      last: '3\n',
      'head-name': 'refs/heads/apply-branch\n',
      onto: 'cdc8a8f9e4ebfa7a67e97f0d2b8e2f6b9dfd0516\n',
      'final-commit': 'am backend subject\nmore body\n'
    })

    expect(await readGitRebaseProgress(gitDir)).toEqual({
      headName: 'apply-branch',
      onto: 'cdc8a8f9e4ebfa7a67e97f0d2b8e2f6b9dfd0516',
      currentStep: 1,
      totalSteps: 3,
      commitSubject: 'am backend subject'
    })
  })

  it('prefers rebase-merge when both directories exist', async () => {
    await writeState('rebase-apply', { next: '1', last: '3', 'head-name': 'refs/heads/apply' })
    await writeState('rebase-merge', { msgnum: '2', end: '9', 'head-name': 'refs/heads/merge' })

    expect(await readGitRebaseProgress(gitDir)).toEqual({
      headName: 'merge',
      currentStep: 2,
      totalSteps: 9
    })
  })
})

describe('readGitRebaseProgress — no state', () => {
  it('returns undefined when neither directory exists', async () => {
    expect(await readGitRebaseProgress(gitDir)).toBeUndefined()
  })

  it('returns undefined for an empty state directory', async () => {
    await writeState('rebase-merge', {})

    expect(await readGitRebaseProgress(gitDir)).toBeUndefined()
  })

  it('returns undefined for a git dir that does not exist', async () => {
    expect(await readGitRebaseProgress(path.join(gitDir, 'missing'))).toBeUndefined()
  })
})
