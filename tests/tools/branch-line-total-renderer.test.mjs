import { runProcess } from '@orca/process-host'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { getBranchCompare, getStatus, invalidateGitReadCaches } from '../../src/main/git/status'
import { createEditorStore } from '../../src/renderer/src/store/slices/editor-slice-test-harness'

async function git(repo, ...args) {
  const result = await runProcess({ program: 'git', args, cwd: repo })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

it('removes a published deletion total when the host finds an untracked recreation', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'orca-renderer-branch-total-'))
  invalidateGitReadCaches()
  try {
    await git(repo, 'init', '-q')
    await git(repo, 'config', 'user.email', 'test@example.com')
    await git(repo, 'config', 'user.name', 'Test')
    await git(repo, 'config', 'commit.gpgSign', 'false')
    await writeFile(join(repo, 'gone.txt'), 'one\ntwo\nthree\n')
    await git(repo, 'add', 'gone.txt')
    await git(repo, 'commit', '-qm', 'base file')
    await git(repo, 'branch', 'base')
    await git(repo, 'checkout', '-qb', 'feature')
    await git(repo, 'rm', '-q', 'gone.txt')
    await git(repo, 'commit', '-qm', 'delete file')
    const { summary } = await getBranchCompare(repo, 'base')
    expect(summary.status).toBe('ready')
    const mergeBase = summary.mergeBase
    if (!mergeBase) {
      throw new Error('Missing merge base')
    }
    const options = { branchLineTotalMergeBase: mergeBase }
    const store = createEditorStore()
    const refresh = async (reuseLineStats = false) => {
      store.getState().setGitStatus('wt-1', await getStatus(repo, { ...options, reuseLineStats }))
    }

    await refresh()
    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toMatchObject({
      added: 0,
      removed: 3,
      mergeBase
    })

    await writeFile(join(repo, 'gone.txt'), 'replacement\nfile\n')
    await refresh()
    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toBeUndefined()
    await refresh(true)
    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toBeUndefined()
    expect((await getBranchCompare(repo, 'base')).summary.mergeBase).toBe(mergeBase)

    await git(repo, 'add', 'gone.txt')
    invalidateGitReadCaches()
    await refresh()
    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toMatchObject({
      added: 2,
      removed: 3,
      mergeBase
    })
  } finally {
    invalidateGitReadCaches()
    await rm(repo, { recursive: true, force: true })
  }
})
