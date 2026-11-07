import { describe, expect, it, vi } from 'vitest'
import { resolveConfiguredGitPushTarget } from '../remotes/git-push-target-resolution'

function createRunner(config = new Map<string, string>(), snapshotFails = false) {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'symbolic-ref') {
      return { stdout: 'refs/heads/feature\n' }
    }
    if (args[0] === 'config' && args[1] === '--list') {
      if (snapshotFails) {
        throw new Error('snapshot unavailable')
      }
      return { stdout: Array.from(config, ([key, value]) => `${key}\n${value}\0`).join('') }
    }
    if (args[0] === 'config' && args[1] === '--get') {
      const value = config.get((args[2] ?? '').toLowerCase())
      if (value === undefined) {
        throw new Error('missing config key')
      }
      return { stdout: `${value}\n` }
    }
    if (args[0] === 'rev-parse') {
      throw new Error(args.includes('HEAD@{u}') ? 'fatal: no upstream configured' : 'missing ref')
    }
    throw new Error(`unexpected Git command: ${args.join(' ')}`)
  })
}

describe('resolution config snapshots', () => {
  it('reads a fresh push snapshot after branch config changes', async () => {
    const config = new Map([
      ['branch.feature.remote', 'fork'],
      ['branch.feature.merge', 'refs/heads/feature']
    ])
    const runGit = createRunner(config)

    await expect(resolveConfiguredGitPushTarget(runGit)).resolves.toEqual({
      remote: 'fork',
      refspec: 'HEAD:feature'
    })
    config.set('remote.pushdefault', 'other-fork')
    await expect(resolveConfiguredGitPushTarget(runGit)).resolves.toEqual({
      remote: 'other-fork',
      refspec: 'HEAD:feature'
    })

    expect(runGit.mock.calls.filter(([args]) => args[0] === 'config')).toEqual([
      [['config', '--list', '-z']],
      [['config', '--list', '-z']]
    ])
  })
})
