import { getPublishTargetStatus } from './git-publish-target-status'
import { acquireGitNativeFacts, readGitRemotePolicy } from './git-worktree-admin'
import { prepareWorktreePushTargetWithExec } from '../main/ipc/worktree-push-target-setup'
import { fetchForkBranch, runForkNativeAction } from '../main/git/fork-remote-refspec'
import { migrateForkRemoteRefspecsWithExec } from '../main/ipc/worktree-push-target-refspec-migration'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

import { join } from 'node:path'
import { expect, it } from 'vitest'

import type { GitBinaryTestFixture } from './git-binary.test-fixture'

export function registerGitForkBinaryCompatibilityCase(
  getFixture: () => GitBinaryTestFixture,
  getRepoPath: () => string
): void {
  it('executes fork preparation, strict actions and selective contraction on the selected binary', async () => {
    const fixture = getFixture()
    const repoPath = getRepoPath()
    const local = join(repoPath, 'fork-contract'),
      remote = join(repoPath, 'fork-contract.git')
    await mkdir(join(repoPath, 'fork-contract'))
    const run = (args: string[], cwd = local) => fixture.exec(args, cwd)
    await run(['init', '-q'])
    await run(['config', 'user.name', 'Fork Test'])
    await run(['config', 'user.email', 'fork@example.invalid'])
    await run(['config', 'commit.gpgSign', 'false'])
    await run(['config', 'core.hooksPath', join(fixture.executionRoot, 'no-hooks')])
    await run(['commit', '--allow-empty', '-qm', 'seed'])
    const branch = 'topic(compat)+$'
    await run(['branch', branch])
    await run(['clone', '--bare', '-q', local, remote])
    const calls: string[][] = []
    const checked = (args: string[], cwd: string) => {
      calls.push(args)
      return run(args, cwd)
    }
    const target = await prepareWorktreePushTargetWithExec(
      checked,
      local,
      { remoteName: 'pr-compat', remoteUrl: remote, branchName: branch },
      '',
      true
    )
    expect(calls.find((args) => args[0] === 'remote' && args[1] === 'add')).toContain('--no-tags')
    expect(calls.find((args) => args[0] === 'remote' && args[1] === 'add')).toContain(`${branch}*`)
    expect(
      (
        await run([
          'for-each-ref',
          '--format=%(upstream:remotename)%00%(upstream:remoteref)',
          (await run(['symbolic-ref', 'HEAD'])).stdout.trim()
        ])
      ).stdout.trim()
    ).toBe(`pr-compat\0refs/heads/${branch}`)
    const oid = (await run(['rev-parse', 'HEAD'])).stdout.trim()
    await run(['update-ref', '-d', `refs/heads/${branch}`], remote)
    await fetchForkBranch(
      checked,
      local,
      target.remoteName,
      target.branchName,
      '',
      target.remoteUrl
    )
    expect((await run(['rev-parse', 'HEAD@{u}'])).stdout.trim()).toBe(oid)
    await run(['update-ref', `refs/heads/${branch}`, oid], remote)
    await fetchForkBranch(
      checked,
      local,
      target.remoteName,
      target.branchName,
      '',
      target.remoteUrl
    )
    expect(
      calls.some((args) =>
        args.includes(`--refmap=+refs/heads/${branch}:refs/remotes/pr-compat/${branch}`)
      )
    ).toBe(true)
    await run(['commit', '--allow-empty', '-qm', 'push'])
    await runForkNativeAction(checked, local, target, 'push', () =>
      run(['push', '--set-upstream', target.remoteName, `HEAD:refs/heads/${branch}`])
    )
    expect((await run(['rev-parse', `refs/heads/${branch}`], remote)).stdout).toBe(
      (await run(['rev-parse', 'HEAD'])).stdout
    )
    await runForkNativeAction(checked, local, target, 'pull', () =>
      run(['pull', '--ff-only', target.remoteName, branch])
    )
    await run(['remote', 'add', 'manual-compat', remote])
    const key = 'remote.manual-compat.fetch'
    await run(['config', '--add', key, 'refs/heads/main'])
    const rawPolicy = (await run(['config', '--get-regexp', '^remote\\.manual-compat\\.'])).stdout
    expect(
      (
        await prepareWorktreePushTargetWithExec(
          checked,
          local,
          { ...target, remoteName: 'manual-compat' },
          '',
          true
        )
      ).remoteName
    ).toBe('manual-compat')
    expect((await run(['config', '--get-regexp', '^remote\\.manual-compat\\.'])).stdout).toBe(
      rawPolicy
    )
    await expect(run(['config', '--get', 'remote.manual-compat.orca-created'])).rejects.toThrow()
    await run(['config', '--unset-all', key])
    await run(['config', '--add', key, `refs/heads/${branch}:`])
    await run(['config', '--add', key, '+refs/heads/*:refs/remotes/manual-compat/*'])
    expect(
      (
        await prepareWorktreePushTargetWithExec(
          checked,
          local,
          { ...target, remoteName: 'manual-compat' },
          '',
          true
        )
      ).remoteName
    ).toBe('manual-compat-2')
    const legacyPath = join(local, '.git', 'remotes')
    await mkdir(legacyPath)
    const legacy = `URL: ${remote}\nPull: +refs/heads/*:refs/remotes/legacy-compat/*\n`
    await writeFile(join(legacyPath, 'legacy-compat'), legacy)
    expect(
      (
        await prepareWorktreePushTargetWithExec(
          checked,
          local,
          { ...target, remoteName: 'legacy-compat' },
          '',
          true
        )
      ).remoteName
    ).toBe('legacy-compat')
    expect(await readFile(join(legacyPath, 'legacy-compat'), 'utf8')).toBe(legacy)
    const selectedReader = async (name: string) =>
      (await readGitRemotePolicy(checked, local, name)).fields
    const customDestination = 'refs/review/compat/topic'
    await run(['update-ref', customDestination, oid])
    for (const [rows, hasUpstream] of [
      [`Pull: refs/heads/${branch}\nPull: refs/heads/${branch}:${customDestination}\n`, true],
      [`Pull: refs/heads/${branch}:\nPull: refs/heads/${branch}:${customDestination}\n`, false],
      [
        `Pull: refs/heads/${branch}:refs/heads/${(await run(['branch', '--show-current'])).stdout.trim()}\n`,
        true
      ]
    ] as const) {
      await writeFile(join(legacyPath, 'legacy-query'), `URL: ${remote}\n${rows}`)
      const status = await getPublishTargetStatus(
        (args) => checked(args, local),
        { ...target, remoteName: 'legacy-query' },
        selectedReader
      )
      expect(status.hasUpstream).toBe(hasUpstream)
    }
    await rm(join(legacyPath, 'legacy-query'))
    await mkdir(join(legacyPath, 'directory-entry'))
    await writeFile(join(legacyPath, 'empty-entry'), '')
    const nativeDirectory = await run(['remote', 'get-url', 'directory-entry']).then(
      () => true,
      () => false
    )
    const nativeEmpty = await run(['remote', 'get-url', 'empty-entry']).then(
      () => true,
      () => false
    )
    const classified = await acquireGitNativeFacts(checked, local)
    expect(classified.names.has('directory-entry')).toBe(nativeDirectory)
    expect(classified.names.has('empty-entry')).toBe(nativeEmpty)
    expect(
      (
        await prepareWorktreePushTargetWithExec(
          checked,
          local,
          { ...target, remoteName: 'legacy-compat' },
          '',
          true
        )
      ).remoteName
    ).toBe('legacy-compat')
    const branchesPath = join(local, '.git', 'branches')
    await mkdir(branchesPath)
    const other = join(repoPath, 'compat-other.git')
    await run(['clone', '--bare', '-q', remote, other])
    const oldBranchPolicy = `${other}#${branch}\n`
    await writeFile(join(branchesPath, 'old-local'), oldBranchPolicy)
    expect((await run(['remote', 'get-url', 'old-local'])).stdout.trim()).toBe(other)
    await run(['fetch', '--no-tags', 'old-local'])
    const legacyHead = (await run(['rev-parse', 'refs/heads/old-local'])).stdout
    const oldLocal = await prepareWorktreePushTargetWithExec(
      checked,
      local,
      { ...target, remoteName: 'old-local', remoteUrl: other },
      '',
      true
    )
    expect(oldLocal.remoteName).toBe('old-local-2')
    expect((await run(['rev-parse', 'refs/heads/old-local'])).stdout).toBe(legacyHead)
    expect(await readFile(join(branchesPath, 'old-local'), 'utf8')).toBe(oldBranchPolicy)
    await expect(run(['config', '--get', 'remote.old-local.orca-created'])).rejects.toThrow()
    // A real pre-write refusal from the selected binary advances exactly once.
    const raceRemote = join(repoPath, 'compat-race.git')
    await run(['clone', '--bare', '-q', remote, raceRemote])
    let collided = false
    const racing = async (args: string[], cwd: string) => {
      if (!collided && args[0] === 'remote' && args[1] === 'add') {
        collided = true
        await run(['remote', 'add', args.at(-2)!, remote], cwd)
      }
      return checked(args, cwd)
    }
    const raced = await prepareWorktreePushTargetWithExec(
      racing,
      local,
      { ...target, remoteName: 'race-compat', remoteUrl: raceRemote },
      '',
      true
    )
    expect(raced.remoteName).toBe('race-compat-2')
    expect((await run(['remote', 'get-url', 'race-compat'])).stdout.trim()).toBe(remote)
    expect(
      (await run(['config', '--bool', '--get', 'remote.race-compat-2.orca-created'])).stdout.trim()
    ).toBe('true')
    await expect(run(['config', '--get', 'remote.race-compat.orca-created'])).rejects.toThrow()
    const compatPolicy = (await run(['config', '--get-regexp', '^remote\\.pr-compat\\.'])).stdout
    const keeper = join(repoPath, 'compat-keeper')
    await run(['worktree', 'add', '-qb', 'compat-keeper', keeper])
    await run(['config', 'extensions.worktreeConfig', 'true'])
    await run(['config', '--worktree', 'branch.compat-keeper.remote', 'pr-compat'], keeper)
    await run(
      ['config', '--worktree', 'branch.compat-keeper.merge', `refs/heads/${branch}`],
      keeper
    )
    const beforeKeeper = (await run(['rev-parse', 'HEAD@{u}'], keeper)).stdout
    const keeperAdmin = (await run(['rev-parse', '--absolute-git-dir'], keeper)).stdout.trim()
    await rm(keeper, { recursive: true, force: true })
    const noMeta = { getAllWorktreeMeta: () => ({}) }
    await migrateForkRemoteRefspecsWithExec(local, 'compat', noMeta, checked)
    expect((await run(['--git-dir=.', 'rev-parse', 'compat-keeper@{u}'], keeperAdmin)).stdout).toBe(
      beforeKeeper
    )
    expect((await run(['config', '--get-regexp', '^remote\\.pr-compat\\.'])).stdout).toBe(
      compatPolicy
    )
    await writeFile(join(keeperAdmin, 'config.worktree'), '')
    await prepareWorktreePushTargetWithExec(checked, local, target, '', true)
    await run([
      'config',
      '--replace-all',
      'remote.pr-compat.fetch',
      '+refs/heads/*:refs/remotes/pr-compat/*'
    ])
    await run(['update-ref', 'refs/remotes/pr-compat/stale', oid])
    const saved = { getAllWorktreeMeta: () => ({}) }
    expect(await migrateForkRemoteRefspecsWithExec(local, 'compat', saved, checked)).toEqual([
      'pr-compat'
    ])
    expect((await run(['config', '--get-all', 'remote.pr-compat.fetch'])).stdout.trim()).toBe(
      `+refs/heads/${branch}*:refs/remotes/pr-compat/${branch}*`
    )
    await expect(run(['rev-parse', '--verify', 'refs/remotes/pr-compat/stale'])).rejects.toThrow()
    await run([
      'config',
      '--remove-section',
      `branch.${(await run(['branch', '--show-current'])).stdout.trim()}`
    ])
    expect(await migrateForkRemoteRefspecsWithExec(local, 'compat', saved, checked)).toEqual([
      'pr-compat'
    ])
    await expect(run(['config', '--get-all', 'remote.pr-compat.fetch'])).rejects.toThrow()
    expect(
      calls
        .filter((args) => args.includes('--unset-all'))
        .every((args) => args.length === 4 && args[3].startsWith('^') && args[3].endsWith('$'))
    ).toBe(true)
  })
}
