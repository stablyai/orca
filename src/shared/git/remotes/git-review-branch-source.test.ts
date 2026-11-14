import { runProcess } from '@orca/process-host'
import { mkdtemp, rm } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readGitReviewBranchSources } from './git-review-branch-source'
const exec = async (
  program: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => {
  const result = await runProcess({ program, args, ...options })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result
}
it('resolves real Git tracking, triangular publication, local tracking and explicit branch mappings', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'gitlab-review-parity-1108-'))
  const git = (args: string[]) =>
    exec('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
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
      pushBranchName: null,
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

it('resolves effective push configuration without confusing discovery with publication', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'review-push-config-'))
  const git = (args: string[]) =>
    exec('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
    })
  try {
    await git(['init', '--quiet'])
    await git(['config', 'remote.fork.url', 'https://github.com/team/repo.git'])
    await git(['config', 'remote.fork.pushurl', 'https://github.com/other/repo.git'])
    await git(['config', 'remote.fork.push', 'refs/heads/feature:refs/heads/published'])
    const source = async () => (await readGitReviewBranchSources(git, ['feature'])).get('feature')
    expect(await source()).toMatchObject({ remoteName: 'fork', branchName: 'published' })
    await git(['config', '--unset', 'remote.fork.push'])
    await git(['config', 'branch.feature.pushRemote', 'https://github.com/team/repo.git'])
    await git(['config', 'push.default', 'current'])
    expect(await source()).toMatchObject({ urls: ['https://github.com/team/repo.git'] })
    await git(['config', '--unset', 'branch.feature.pushRemote'])
    await git(['config', 'branch.feature.remote', 'fork'])
    await git(['config', 'branch.feature.merge', 'refs/heads/published'])
    await git(['config', 'push.default', 'tracking'])
    expect(await source()).toMatchObject({ pushBranchName: 'published' })
    await git(['config', '--unset', 'branch.feature.merge'])
    await git(['config', 'push.autoSetupRemote', '2'])
    expect(await source()).toMatchObject({
      branchName: 'feature',
      urls: ['https://github.com/other/repo.git']
    })
    expect(await source()).not.toHaveProperty('pushBranchName')
    await git(['config', '--unset', 'push.autoSetupRemote'])
    await git(['config', 'push.default', 'nothing'])
    await git(['config', 'remote.fork.mirror', 'true'])
    expect(await source()).not.toHaveProperty('pushBranchName')
    expect(await source()).toMatchObject({
      branchName: 'feature',
      urls: ['https://github.com/other/repo.git']
    })
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

it('uses a literal push URL rather than the named remote pushurl', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'review-literal-url-'))
  const git = (args: string[]) =>
    exec('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
    })
  try {
    await git(['init', '--quiet'])
    await git(['config', 'remote.origin.url', 'https://github.com/team/repo.git'])
    await git(['config', 'remote.origin.pushurl', 'https://github.com/other/repo.git'])
    await git(['config', 'branch.feature.pushRemote', 'https://github.com/team/repo.git'])
    await git(['config', 'push.default', 'current'])
    expect((await readGitReviewBranchSources(git, ['feature'])).get('feature')).toMatchObject({
      urls: ['https://github.com/team/repo.git']
    })
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
