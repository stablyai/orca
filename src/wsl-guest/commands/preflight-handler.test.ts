import type * as WslAvailability from '../../main/wsl/discovery/wsl-availability'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPosixCommandPathLookupScript } from '../../shared/shell/command-resolution/posix-command-path-lookup'

const { execFileAsyncMock, runProcessMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  runProcessMock: vi.fn()
}))

const {
  isPwshAvailableAsyncMock,
  isWslAvailableAsyncMock,
  listWslDistrosAsyncMock,
  isGitBashAvailableMock
} = vi.hoisted(() => ({
  isPwshAvailableAsyncMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  listWslDistrosAsyncMock: vi.fn(),
  isGitBashAvailableMock: vi.fn()
}))

vi.mock('child_process', () => {
  const execFileWithPromisify = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
  return { execFile: execFileWithPromisify }
})

vi.mock('../../main/pty/shell-startup/pwsh', () => ({
  isPwshAvailableAsync: isPwshAvailableAsyncMock
}))
vi.mock('../../main/wsl/discovery/wsl-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof WslAvailability>()),
  ...(await (() => ({
    isWslAvailableAsync: isWslAvailableAsyncMock
  }))())
}))
vi.mock('../../main/wsl/discovery/distro-catalog', () => ({
  listWslDistrosAsync: listWslDistrosAsyncMock
}))
vi.mock('../../main/pty/shell-startup/git-bash', () => ({
  isGitBashAvailable: isGitBashAvailableMock
}))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { hasAbsoluteCommandPath, isCommandOnPathForRelay } from './preflight-handler'

function shLookupScript(command: string): string {
  return [
    buildPosixCommandPathLookupScript(
      { kind: 'literal', value: command },
      { skipWindowsMountDirs: true }
    ),
    'if [ -n "$resolved" ]; then',
    'printf \'__ORCA_AGENT_PATH__%s\\n\' "$resolved"',
    'fi'
  ].join('\n')
}

function lookupArgs(command: string, mode: '-lc' | '-ilc' = '-lc'): string[] {
  return [mode, shLookupScript(command)]
}

beforeEach(() => {
  execFileAsyncMock.mockReset()
  runProcessMock.mockReset()
  isPwshAvailableAsyncMock.mockReset()
  isWslAvailableAsyncMock.mockReset()
  listWslDistrosAsyncMock.mockReset()
  isGitBashAvailableMock.mockReset()
})

describe('isCommandOnPathForRelay', () => {
  it('does not execute an untrusted configured shell before inherited PATH lookup', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__/relay/path/codex\n' })

    await expect(
      isCommandOnPathForRelay('codex', {
        platform: 'linux',
        env: { SHELL: '/tmp/zsh', PATH: '/usr/bin' },
        accountLoginShell: '/bin/bash'
      })
    ).resolves.toBe(true)
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(execFileAsyncMock).toHaveBeenCalledWith('/bin/sh', lookupArgs('codex'), {
      encoding: 'utf-8',
      env: expect.objectContaining({ SHELL: '/tmp/zsh' }),
      timeout: 5000
    })
  })
})

describe('hasAbsoluteCommandPath', () => {
  it('ignores unmarked POSIX absolute paths from shell startup output', () => {
    expect(hasAbsoluteCommandPath('/tmp/not-the-agent\n', 'linux')).toBe(false)
  })
})
