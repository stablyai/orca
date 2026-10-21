import { describe, expect, it, vi } from 'vitest'
import {
  getEffectiveGitUpstreamStatus,
  resolveEffectiveGitUpstream
} from './git-effective-upstream'
import { resolveConfiguredGitPushTarget } from './git-push-target-resolution'

function createRunner(config = new Map<string, string>(), snapshotFails = false) {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'symbolic-ref') {
      return { stdout: 'feature\n' }
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
  it('shares one snapshot across upstream fallback and push-target status checks', async () => {
    const runGit = createRunner()

    await expect(getEffectiveGitUpstreamStatus(runGit)).resolves.toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })

    expect(runGit.mock.calls.filter(([args]) => args[0] === 'config')).toEqual([
      [['config', '--list', '-z']]
    ])
    expect(runGit).toHaveBeenCalledTimes(4)
  })

  it('shares one snapshot across pull upstream config lookups', async () => {
    const runGit = createRunner()

    await expect(resolveEffectiveGitUpstream(runGit)).resolves.toBeNull()

    expect(runGit.mock.calls.filter(([args]) => args[0] === 'config')).toEqual([
      [['config', '--list', '-z']]
    ])
  })

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

  it('falls back to individual config reads once when the snapshot fails', async () => {
    const runGit = createRunner(
      new Map([
        ['branch.feature.remote', 'fork'],
        ['branch.feature.merge', 'refs/heads/feature']
      ]),
      true
    )

    await expect(resolveConfiguredGitPushTarget(runGit)).resolves.toEqual({
      remote: 'fork',
      refspec: 'HEAD:feature'
    })

    expect(runGit.mock.calls.filter(([args]) => args[1] === '--list')).toHaveLength(1)
    expect(runGit.mock.calls.filter(([args]) => args[1] === '--get')).toHaveLength(5)
  })

  it('skips config reads when the configured upstream resolves directly', async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'origin/feature\n' }
      }
      return { stdout: '1\t0\n' }
    })

    await expect(getEffectiveGitUpstreamStatus(runGit)).resolves.toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 1,
      behind: 0
    })

    expect(runGit.mock.calls.filter(([args]) => args[0] === 'config')).toHaveLength(0)
  })
})
