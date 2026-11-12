import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readGitReviewBranchSources } from './git-review-branch-source'
const exec = promisify(execFile)
it('resolves real Git tracking, triangular publication, local tracking and explicit branch mappings', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'gitlab-review-parity-1108-'))
  const git = (args: string[]) =>
    exec('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    })
  try {
    await git(['init', '--quiet'])
    for (const [key, value] of [
      ['remote.origin.url', 'https://gitlab.com/team/repo.git'],
      ['remote.fork.url', 'https://gitlab.com/me/repo.git'],
      ['branch.feature.remote', 'origin'],
      ['branch.feature.merge', 'refs/heads/main'],
      ['branch.wip.remote', 'origin'],
      ['branch.wip.merge', 'refs/heads/renamed'],
      ['branch.dot.remote', '.'],
      ['branch.dot.merge', 'refs/heads/main']
    ]) {
      await git(['config', key, value])
    }
    const snapshot = () => readGitReviewBranchSources(git, ['feature', 'wip', 'dot'])
    expect((await snapshot()).get('feature')).toMatchObject({
      branchName: 'feature',
      trackedBranchName: 'main',
      urls: ['https://gitlab.com/team/repo.git']
    })
    expect((await snapshot()).get('wip')).toMatchObject({
      branchName: 'wip',
      trackedBranchName: 'renamed'
    })
    expect((await snapshot()).get('dot')).toEqual({
      remoteName: 'origin',
      branchName: 'dot',
      urls: ['https://gitlab.com/team/repo.git']
    })
    await git(['config', 'remote.origin.push', 'HEAD'])
    expect((await snapshot()).get('feature')).toMatchObject({ branchName: 'feature' })
    await git(['config', 'remote.origin.push', 'refs/heads/main:refs/heads/main'])
    expect((await snapshot()).get('feature')).toMatchObject({
      branchName: 'feature',
      trackedBranchName: 'main',
      pushBranchName: null
    })
    await git(['config', '--unset', 'remote.origin.push'])
    await git(['config', 'push.default', 'nothing'])
    expect((await snapshot()).get('feature')).toMatchObject({
      branchName: 'feature',
      pushBranchName: null
    })
    await git(['config', 'branch.feature.merge', 'refs/tags/v1'])
    await git(['config', 'push.default', 'upstream'])
    expect((await snapshot()).get('feature')).toEqual({
      remoteName: 'origin',
      branchName: 'feature',
      pushBranchName: null,
      urls: ['https://gitlab.com/team/repo.git']
    })
    await git(['config', 'branch.feature.merge', 'refs/heads/published'])
    await git(['config', 'remote.origin.pushurl', 'https://gitlab.com/me/repo.git'])
    expect((await snapshot()).get('feature')).toMatchObject({
      remoteName: 'origin',
      branchName: 'feature',
      pushBranchName: 'published',
      urls: ['https://gitlab.com/me/repo.git']
    })
    await git(['config', '--unset', 'remote.origin.pushurl'])
    await git(['config', 'push.default', 'simple'])
    await git(['config', 'branch.feature.merge', 'refs/heads/main'])
    await git(['config', 'remote.pushDefault', 'fork'])
    expect((await snapshot()).get('feature')).toEqual({
      remoteName: 'fork',
      branchName: 'feature',
      urls: ['https://gitlab.com/me/repo.git']
    })
    await git(['config', 'branch.feature.pushRemote', 'origin'])
    await git(['config', 'remote.origin.push', 'refs/heads/feature:refs/heads/published'])
    expect((await snapshot()).get('feature')).toEqual({
      remoteName: 'origin',
      branchName: 'published',
      urls: ['https://gitlab.com/team/repo.git']
    })
    await git(['config', '--add', 'remote.origin.push', 'refs/heads/feature:refs/heads/other'])
    expect((await snapshot()).get('feature')).toBeInstanceOf(Error)
    await git(['config', '--replace-all', 'remote.origin.push', 'refs/heads/feature:refs/tags/v1'])
    expect((await snapshot()).get('feature')).toBeInstanceOf(Error)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
