import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { refreshBranchCleanupTargetRefs } from '../branches/git-branch-cleanup-fetch'

import { GitBinaryTestFixture } from './git-binary.test-fixture'

import { registerGitResolutionBinaryCompatibilityCases } from './git-resolution-binary-compatibility.test-cases'

const image = process.env.ORCA_GIT_COMPAT_IMAGE
const binary = process.env.ORCA_GIT_COMPAT_BINARY
const expectedVersion = process.env.ORCA_GIT_COMPAT_VERSION
const describeBinaryCompatibility = image || binary ? describe : describe.skip

type GitResult = { stdout: string; stderr: string }

describeBinaryCompatibility('real Git binary compatibility', () => {
  let repoPath = ''
  let fixture: GitBinaryTestFixture

  async function runGit(
    args: string[],
    env?: NodeJS.ProcessEnv,
    stdin?: string
  ): Promise<GitResult> {
    return fixture.exec(args, fixture.executionRoot, env, stdin)
  }

  beforeAll(async () => {
    repoPath = await realpath(await mkdtemp(join(tmpdir(), 'orca-git-binary-compat-')))
    fixture = new GitBinaryTestFixture(repoPath, '/repo')
    await fixture.start()
    const versionOutput = await runGit(['--version'])
    expect(versionOutput.stdout).toContain(`git version ${expectedVersion}`)
    const match = versionOutput.stdout.match(/git version (\d+)\.(\d+)/)
    expect(match).not.toBeNull()

    await runGit(['init', '-q'])
    await runGit(['config', 'user.email', 'compatibility@example.invalid'])
    await runGit(['config', 'user.name', 'Compatibility Test'])
    await writeFile(join(repoPath, 'tracked.txt'), 'compatibility\n')
    await runGit(['add', 'tracked.txt'])
    await runGit(['commit', '-qm', 'initial'])
  })

  afterAll(async () => {
    if (repoPath) {
      try {
        await fixture.stop()
      } finally {
        await rm(repoPath, { recursive: true, force: true })
      }
    }
  })

  it('refreshes a cleanup base with maintenance disabled and an explicit refspec', async () => {
    const branch = 'compat-cleanup-source'
    const remote = 'compat-cleanup'
    const target = `refs/remotes/${remote}/${branch}`
    await runGit(['branch', branch, 'HEAD'])
    await runGit(['remote', 'add', remote, '.'])
    try {
      await expect(
        refreshBranchCleanupTargetRefs((args) => runGit(args), [target])
      ).resolves.toEqual([target])
      expect((await runGit(['rev-parse', target])).stdout).toBe(
        (await runGit(['rev-parse', branch])).stdout
      )
    } finally {
      await runGit(['remote', 'remove', remote])
      await runGit(['branch', '-D', branch])
    }
  })

  registerGitResolutionBinaryCompatibilityCases(runGit)
})
