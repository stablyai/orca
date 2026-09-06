// Why: resolving a URL-valued `branch.<name>.remote` (or `remote.pushDefault`) to a
// remote name used to cost `git remote` plus one serial `git remote get-url` per remote.
// `hasConfiguredBranchPushTarget` resolves up to two of them, so a 58-remote repo paid
// up to 118 subprocesses for one question. These tests pin the count and result parity.

import { describe, expect, it } from 'vitest'
import {
  getConfiguredBranchRemoteUpstream,
  hasConfiguredBranchPushTarget
} from './git-configured-branch-target'

const BRANCH = 'imp/translation'
const FORK_URL = 'https://github.com/contributor/orca.git'
const UPSTREAM_URL = 'https://github.com/stablyai/orca.git'

type RemoteRow = { name: string; fetchUrl: string; pushUrl?: string }

type Fixture = {
  remotes: readonly RemoteRow[]
  config: Readonly<Record<string, string>>
}

function makeRunner(fixture: Fixture): {
  runGit: (args: string[]) => Promise<{ stdout: string }>
  spawns: string[][]
} {
  const spawns: string[][] = []
  const runGit = async (args: string[]): Promise<{ stdout: string }> => {
    spawns.push(args)
    if (args[0] === 'config' && args[1] === '--get') {
      const value = fixture.config[args[2]]
      if (value === undefined) {
        throw Object.assign(new Error('config key is not set'), { code: 1 })
      }
      return { stdout: `${value}\n` }
    }
    if (args[0] === 'remote' && args[1] === '-v') {
      return {
        stdout: fixture.remotes
          .flatMap((remote) => [
            `${remote.name}\t${remote.fetchUrl} (fetch)`,
            `${remote.name}\t${remote.pushUrl ?? remote.fetchUrl} (push)`
          ])
          .join('\n')
      }
    }
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: `${fixture.remotes.map((remote) => remote.name).join('\n')}\n` }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const match = fixture.remotes.find((remote) => remote.name === args[2])
      if (!match) {
        throw new Error(`No such remote ${args[2]}`)
      }
      return { stdout: `${match.fetchUrl}\n` }
    }
    throw new Error(`unexpected git command: ${args.join(' ')}`)
  }
  return { runGit, spawns }
}

const fiftyEightRemotes: RemoteRow[] = [
  { name: 'origin', fetchUrl: UPSTREAM_URL },
  ...Array.from({ length: 56 }, (_, index) => ({
    name: `pr-user${index}-orca`,
    fetchUrl: `https://github.com/user${index}/orca.git`
  })),
  { name: 'pr-contributor-orca', fetchUrl: FORK_URL }
]

describe('hasConfiguredBranchPushTarget', () => {
  it('resolves both URL-valued remotes from one remote table read at 58 remotes', async () => {
    const { runGit, spawns } = makeRunner({
      remotes: fiftyEightRemotes,
      config: {
        [`branch.${BRANCH}.pushRemote`]: FORK_URL,
        [`branch.${BRANCH}.remote`]: FORK_URL,
        [`branch.${BRANCH}.merge`]: `refs/heads/${BRANCH}`
      }
    })

    await expect(hasConfiguredBranchPushTarget(runGit, BRANCH)).resolves.toBe(true)

    // Both the push remote and the branch remote name the same URL, so one table read answers.
    expect(spawns.filter((args) => args[0] === 'remote')).toEqual([['remote', '-v']])
    expect(spawns.filter((args) => args[1] === 'get-url')).toEqual([])
  })

  it('keeps the not-set case false when no remote is configured', async () => {
    const { runGit } = makeRunner({ remotes: fiftyEightRemotes, config: {} })
    await expect(hasConfiguredBranchPushTarget(runGit, BRANCH)).resolves.toBe(false)
  })

  it('keeps the URL itself as the remote name when nothing matches', async () => {
    const { runGit } = makeRunner({
      remotes: [{ name: 'origin', fetchUrl: UPSTREAM_URL }],
      config: {
        [`branch.${BRANCH}.pushRemote`]: FORK_URL,
        [`branch.${BRANCH}.remote`]: FORK_URL,
        [`branch.${BRANCH}.merge`]: 'refs/heads/other'
      }
    })
    // Unchanged no-match fallback: both remotes stay the raw URL, so they still agree
    // and the differently named merge branch is still pushable.
    await expect(hasConfiguredBranchPushTarget(runGit, BRANCH)).resolves.toBe(true)
  })
})

describe('getConfiguredBranchRemoteUpstream', () => {
  const remoteTrackingRefExists = async (): Promise<boolean> => true

  it('picks the first remote holding a duplicated URL', async () => {
    const { runGit, spawns } = makeRunner({
      remotes: [
        { name: 'origin', fetchUrl: UPSTREAM_URL },
        { name: 'fork-a', fetchUrl: FORK_URL },
        { name: 'fork-b', fetchUrl: FORK_URL }
      ],
      config: {
        [`branch.${BRANCH}.remote`]: FORK_URL,
        [`branch.${BRANCH}.merge`]: `refs/heads/${BRANCH}`
      }
    })

    await expect(
      getConfiguredBranchRemoteUpstream(runGit, BRANCH, remoteTrackingRefExists)
    ).resolves.toEqual({
      upstreamName: `fork-a/${BRANCH}`,
      remoteName: 'fork-a',
      branchName: BRANCH,
      isConfiguredUpstream: false
    })
    expect(spawns.filter((args) => args[0] === 'remote')).toEqual([['remote', '-v']])
  })

  it('ignores a push URL when fetch and push differ', async () => {
    const { runGit } = makeRunner({
      remotes: [{ name: 'split', fetchUrl: UPSTREAM_URL, pushUrl: FORK_URL }],
      config: {
        [`branch.${BRANCH}.remote`]: FORK_URL,
        [`branch.${BRANCH}.merge`]: `refs/heads/${BRANCH}`
      }
    })
    await expect(
      getConfiguredBranchRemoteUpstream(runGit, BRANCH, remoteTrackingRefExists)
    ).resolves.toBeNull()
  })

  it('returns null with no remotes at all', async () => {
    const { runGit } = makeRunner({
      remotes: [],
      config: {
        [`branch.${BRANCH}.remote`]: FORK_URL,
        [`branch.${BRANCH}.merge`]: `refs/heads/${BRANCH}`
      }
    })
    await expect(
      getConfiguredBranchRemoteUpstream(runGit, BRANCH, remoteTrackingRefExists)
    ).resolves.toBeNull()
  })

  it('keeps a plain named remote untouched', async () => {
    const { runGit, spawns } = makeRunner({
      remotes: fiftyEightRemotes,
      config: {
        [`branch.${BRANCH}.remote`]: 'origin',
        [`branch.${BRANCH}.merge`]: `refs/heads/${BRANCH}`
      }
    })
    await expect(
      getConfiguredBranchRemoteUpstream(runGit, BRANCH, remoteTrackingRefExists)
    ).resolves.toMatchObject({ remoteName: 'origin' })
    expect(spawns.filter((args) => args[0] === 'remote')).toEqual([])
  })
})
