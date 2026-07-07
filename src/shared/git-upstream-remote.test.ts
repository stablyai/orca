import { describe, expect, it, vi } from 'vitest'
import type { GitForkSyncRunner } from './git-fork-sync'
import { addUpstreamRemote } from './git-upstream-remote'

describe('addUpstreamRemote', () => {
  function createAddRunner(overrides: {
    remotes?: string
    originUrl?: string
    upstreamUrl?: string
    addFails?: boolean
  }): { runGit: GitForkSyncRunner; calls: string[][] } {
    const calls: string[][] = []
    const runGit = vi.fn(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'remote' && args[1] === 'get-url') {
        const remote = args[2]
        if (remote === 'origin') {
          return { stdout: overrides.originUrl ?? 'git@github.com:tebayoso/orca.git\n' }
        }
        return { stdout: overrides.upstreamUrl ?? 'git@github.com:stablyai/orca.git\n' }
      }
      if (args[0] === 'remote' && args[1] === 'add') {
        if (overrides.addFails) {
          throw new Error('remote add failed')
        }
        return { stdout: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: overrides.remotes ?? 'origin\n' }
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    return { runGit, calls }
  }

  const EXPECTED = { owner: 'stablyai', repo: 'orca' }

  // Why: mirroring origin's transport keeps the user's existing auth working —
  // an HTTPS upstream on an SSH-key-only setup would fail every fetch.
  it('adds an upstream remote mirroring the SSH transport of origin', async () => {
    const { runGit, calls } = createAddRunner({})

    const result = await addUpstreamRemote(runGit, EXPECTED)

    expect(result).toEqual({
      ok: true,
      url: 'git@github.com:stablyai/orca.git',
      alreadyExisted: false
    })
    expect(calls).toContainEqual(['remote', 'add', 'upstream', 'git@github.com:stablyai/orca.git'])
  })

  it('adds an HTTPS upstream when origin uses HTTPS', async () => {
    const { runGit } = createAddRunner({ originUrl: 'https://github.com/tebayoso/orca.git\n' })

    const result = await addUpstreamRemote(runGit, EXPECTED)

    expect(result).toEqual({
      ok: true,
      url: 'https://github.com/stablyai/orca.git',
      alreadyExisted: false
    })
  })

  it('is idempotent when upstream already points at the expected slug', async () => {
    const { runGit, calls } = createAddRunner({ remotes: 'origin\nupstream\n' })

    const result = await addUpstreamRemote(runGit, EXPECTED)

    expect(result).toEqual({ ok: true, url: '', alreadyExisted: true })
    expect(calls.some((args) => args[1] === 'add')).toBe(false)
  })

  // Why: silently repointing a user's existing upstream remote would be the
  // same silent-source-switch class the issue-source design rejects.
  it('refuses to touch an upstream remote pointing elsewhere', async () => {
    const { runGit } = createAddRunner({
      remotes: 'origin\nupstream\n',
      upstreamUrl: 'git@github.com:someoneelse/orca.git\n'
    })

    const result = await addUpstreamRemote(runGit, EXPECTED)

    expect(result).toEqual({ ok: false, reason: 'upstream-exists-mismatch' })
  })

  it('reports a missing origin remote', async () => {
    const { runGit } = createAddRunner({ remotes: '\n' })

    const result = await addUpstreamRemote(runGit, EXPECTED)

    expect(result).toEqual({ ok: false, reason: 'missing-origin' })
  })

  it('surfaces the git error when remote add fails', async () => {
    const { runGit } = createAddRunner({ addFails: true })

    const result = await addUpstreamRemote(runGit, EXPECTED)

    expect(result).toEqual({ ok: false, reason: 'add-failed', message: 'remote add failed' })
  })
})
