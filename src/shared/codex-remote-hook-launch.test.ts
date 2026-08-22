import { describe, expect, it } from 'vitest'
import {
  launchTokensDecideCodexHooks,
  planCodexRemoteHookLaunchArgs
} from './codex-remote-hook-launch'

const REMOTE_POSIX = {
  agent: 'codex' as const,
  platform: 'linux' as NodeJS.Platform,
  isRemote: true,
  hooksEnabled: true
}

describe('planCodexRemoteHookLaunchArgs', () => {
  it('gives a remote POSIX Codex launch its own app-server via a hooks override', () => {
    expect(planCodexRemoteHookLaunchArgs(REMOTE_POSIX)).toEqual(['-c', 'features.hooks=true'])
  })

  it('leaves local Codex launches unchanged', () => {
    expect(planCodexRemoteHookLaunchArgs({ ...REMOTE_POSIX, isRemote: false })).toEqual([])
    expect(planCodexRemoteHookLaunchArgs({ ...REMOTE_POSIX, isRemote: undefined })).toEqual([])
  })

  it('leaves Windows remotes unchanged', () => {
    expect(planCodexRemoteHookLaunchArgs({ ...REMOTE_POSIX, platform: 'win32' })).toEqual([])
  })

  it('emits nothing when Orca status hooks are off for this agent', () => {
    expect(planCodexRemoteHookLaunchArgs({ ...REMOTE_POSIX, hooksEnabled: false })).toEqual([])
    expect(planCodexRemoteHookLaunchArgs({ ...REMOTE_POSIX, hooksEnabled: undefined })).toEqual([])
  })

  it('never touches other agents', () => {
    for (const agent of ['claude', 'gemini', 'droid'] as const) {
      expect(planCodexRemoteHookLaunchArgs({ ...REMOTE_POSIX, agent })).toEqual([])
    }
  })

  it('defers to a user who already decided the hooks feature', () => {
    const cases: string[][] = [
      ['--disable', 'hooks'],
      ['--enable', 'hooks'],
      ['-c', 'features.hooks=false'],
      ['--config', 'features.hooks=true'],
      ['-cfeatures.hooks=false'],
      ['--config=features.hooks=false']
    ]
    for (const launchTokens of cases) {
      expect(planCodexRemoteHookLaunchArgs({ ...REMOTE_POSIX, launchTokens })).toEqual([])
    }
  })

  it('still applies when the user set an unrelated flag or feature', () => {
    expect(
      planCodexRemoteHookLaunchArgs({
        ...REMOTE_POSIX,
        launchTokens: ['--enable', 'unified_exec', '-c', 'model="gpt-5"', '--search']
      })
    ).toEqual(['-c', 'features.hooks=true'])
  })
})

describe('launchTokensDecideCodexHooks', () => {
  it('does not treat a bare "hooks" word as a decision', () => {
    expect(launchTokensDecideCodexHooks(['resume', 'hooks'])).toBe(false)
  })

  it('reads the value that follows --enable / --disable', () => {
    expect(launchTokensDecideCodexHooks(['--enable', 'hooks'])).toBe(true)
    expect(launchTokensDecideCodexHooks(['--disable', 'plugin_hooks'])).toBe(false)
  })
})
