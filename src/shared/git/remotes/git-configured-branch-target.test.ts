import { describe, expect, it } from 'vitest'
import { hasConfiguredBranchPushTarget } from './git-configured-branch-target'

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

describe('hasConfiguredBranchPushTarget', () => {
  it('keeps the URL itself as the remote name when nothing matches', async () => {
    const { runGit } = makeRunner({
      remotes: [{ name: 'origin', fetchUrl: UPSTREAM_URL }],
      config: {
        [`branch.${BRANCH}.pushRemote`]: FORK_URL,
        [`branch.${BRANCH}.remote`]: FORK_URL,
        [`branch.${BRANCH}.merge`]: 'refs/heads/other'
      }
    })
    // Retain raw-URL equality on no match so a differently named merge branch remains pushable.
    await expect(hasConfiguredBranchPushTarget(runGit, BRANCH)).resolves.toBe(true)
  })
})
