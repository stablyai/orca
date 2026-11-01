import { describe, expect, it } from 'vitest'
import { shouldRetryTerminate, TERMINATE_RETRY_AFTER_MS } from './wsl-terminate-retry'

const stillListed = {
  retried: false,
  confirmedStopped: false,
  msSinceTerminate: TERMINATE_RETRY_AFTER_MS,
  spawnsSinceTerminate: []
}

describe('shouldRetryTerminate', () => {
  it('retries a terminate that never took when Orca launched nothing since', () => {
    expect(shouldRetryTerminate(stillListed)).toBe(true)
  })

  it.each([
    [
      'a wsl.exe launch',
      { file: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu', '--exec', 'sh'] }
    ],
    ['a running-list read', { file: 'wsl.exe', args: ['--list', '--running', '--quiet'] }],
    ['a UNC touch', { file: 'fs', args: ['stat', '\\\\wsl.localhost\\Ubuntu\\tmp'] }],
    [
      'a terminal spawn',
      { file: 'pty', args: ['[pty:history] worktreeId=wt::\\\\wsl.localhost\\Ubuntu shell=bash'] }
    ]
  ])('fails instead of retrying after %s, which could be the boot', (_label, spawn) => {
    expect(shouldRetryTerminate({ ...stillListed, spawnsSinceTerminate: [spawn] })).toBe(false)
  })

  it('ignores spawns that cannot touch WSL', () => {
    expect(
      shouldRetryTerminate({
        ...stillListed,
        spawnsSinceTerminate: [{ file: 'git.exe', args: ['status'] }]
      })
    ).toBe(true)
  })

  it('retries at most once', () => {
    expect(shouldRetryTerminate({ ...stillListed, retried: true })).toBe(false)
  })

  it('gives the first terminate time to show before retrying', () => {
    expect(
      shouldRetryTerminate({ ...stillListed, msSinceTerminate: TERMINATE_RETRY_AFTER_MS - 1 })
    ).toBe(false)
  })

  it('never retries once a read saw the distro stopped', () => {
    expect(shouldRetryTerminate({ ...stillListed, confirmedStopped: true })).toBe(false)
  })
})
