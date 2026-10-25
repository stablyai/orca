import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPosixCommandPathLookupScript } from '../shared/posix-command-path-lookup'

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

vi.mock('../main/pwsh', () => ({ isPwshAvailableAsync: isPwshAvailableAsyncMock }))
vi.mock('../main/wsl', () => ({
  isWslAvailableAsync: isWslAvailableAsyncMock,
  listWslDistrosAsync: listWslDistrosAsyncMock
}))
vi.mock('../main/git-bash', () => ({ isGitBashAvailable: isGitBashAvailableMock }))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import {
  buildCommandLookupSpecs,
  hasAbsoluteCommandPath,
  isCommandOnPathForRelay,
  PreflightHandler
} from './preflight-handler'

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

describe('buildCommandLookupSpecs', () => {
  it('falls back to inherited PATH after a trusted configured POSIX shell', () => {
    expect(buildCommandLookupSpecs('codex', 'linux', { SHELL: '/bin/zsh' }, '/bin/zsh')).toEqual([
      { file: '/bin/zsh', args: lookupArgs('codex', '-ilc') },
      { file: '/bin/sh', args: lookupArgs('codex') }
    ])
  })

  it('allows a custom shell path only when the account login shell matches', () => {
    expect(
      buildCommandLookupSpecs(
        'codex',
        'darwin',
        { SHELL: '/opt/homebrew/bin/zsh' },
        '/opt/homebrew/bin/zsh'
      )
    ).toEqual([
      { file: '/opt/homebrew/bin/zsh', args: lookupArgs('codex', '-ilc') },
      { file: '/bin/sh', args: lookupArgs('codex') }
    ])
  })

  it('allows conservative system shell paths when account lookup is unavailable', () => {
    expect(buildCommandLookupSpecs('codex', 'linux', { SHELL: '/usr/bin/bash' }, null)[0]).toEqual({
      file: '/usr/bin/bash',
      args: lookupArgs('codex', '-ilc')
    })
  })

  it('skips Windows-mounted PATH dirs so a Windows-only shim is not a guest install', () => {
    const [shellSpec] = buildCommandLookupSpecs('codex', 'linux', { SHELL: '/bin/bash' }, null)
    expect(shellSpec.args[1]).toContain('/proc/mounts')
    expect(shellSpec.args[1]).toBe(shLookupScript('codex'))
  })

  it('runs the POSIX lookup under the fish login PATH for trusted fish shells', () => {
    const script = shLookupScript('codex')
    const fishQuoted = `'${script.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    expect(buildCommandLookupSpecs('codex', 'linux', { SHELL: '/usr/bin/fish' }, null)[0]).toEqual({
      file: '/usr/bin/fish',
      args: ['-ilc', `exec /bin/sh -c ${fishQuoted}`]
    })
  })

  it('ignores untrusted temp shell paths even when the basename is supported', () => {
    expect(buildCommandLookupSpecs('codex', 'linux', { SHELL: '/tmp/zsh' }, '/bin/bash')).toEqual([
      { file: '/bin/sh', args: lookupArgs('codex') }
    ])
  })

  it('ignores untrusted home-bin shell paths even when the basename is supported', () => {
    expect(
      buildCommandLookupSpecs('codex', 'linux', { SHELL: '/home/test/bin/bash' }, '/bin/bash')
    ).toEqual([{ file: '/bin/sh', args: lookupArgs('codex') }])
  })
})

describe('isCommandOnPathForRelay', () => {
  it('falls back to inherited PATH when shell startup returns no absolute command path', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'welcome\ncodex is a function\n' })
      .mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__/relay/path/codex\n' })

    await expect(
      isCommandOnPathForRelay('codex', {
        platform: 'linux',
        env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
        accountLoginShell: '/bin/zsh'
      })
    ).resolves.toBe(true)
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, '/bin/zsh', lookupArgs('codex', '-ilc'), {
      encoding: 'utf-8',
      env: expect.objectContaining({ SHELL: '/bin/zsh' }),
      timeout: 5000
    })
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, '/bin/sh', lookupArgs('codex'), {
      encoding: 'utf-8',
      env: expect.objectContaining({ SHELL: '/bin/zsh' }),
      timeout: 5000
    })
  })

  it('falls back to inherited PATH when shell startup fails', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('startup failed'))
      .mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__/relay/path/codex\n' })

    await expect(
      isCommandOnPathForRelay('codex', {
        platform: 'linux',
        env: { SHELL: '/bin/bash', PATH: '/usr/bin' },
        accountLoginShell: '/bin/bash'
      })
    ).resolves.toBe(true)
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
  })

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

describe('PreflightHandler', () => {
  it('reports a requested version from the resolved execution-host binary', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: '__ORCA_AGENT_PATH__/home/dev/.local/bin/claude\n'
    })
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '2.1.261 (Claude Code)\n',
      stderr: '',
      timedOut: false
    })
    const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    const dispatcher = {
      onRequest: vi.fn(
        (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
          requestHandlers.set(method, handler)
        }
      )
    }
    new PreflightHandler(dispatcher as never)

    await expect(
      requestHandlers.get('preflight.detectAgents')!({
        commands: [{ id: 'claude', cmd: 'claude', reportVersion: true }]
      })
    ).resolves.toEqual({
      agents: ['claude'],
      versions: { claude: '2.1.261 (Claude Code)' }
    })
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/home/dev/.local/bin/claude',
        args: ['--version']
      })
    )
  })

  it('honors required commands when reporting detected agents', async () => {
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      const script = String(args[1])
      if (script.includes("'orca'")) {
        return { stdout: '__ORCA_AGENT_PATH__/relay/path/orca\n' }
      }
      throw new Error('not found')
    })
    const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    const dispatcher = {
      onRequest: vi.fn(
        (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
          requestHandlers.set(method, handler)
        }
      )
    }

    new PreflightHandler(dispatcher as never)

    const handler = requestHandlers.get('preflight.detectAgents')
    expect(handler).toBeDefined()
    await expect(
      handler!({
        commands: [
          { id: 'claude-agent-teams', cmd: 'orca', requiredCommands: ['claude'] },
          { id: 'claude', cmd: 'claude' }
        ]
      })
    ).resolves.toEqual({ agents: [] })
  })

  it('does not report platform-unsupported agents on native Windows SSH hosts', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (String(args[0]) === 'claude') {
        return { stdout: 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd\r\n' }
      }
      if (String(args[0]) === 'orca') {
        return { stdout: 'C:\\Program Files\\Orca\\orca.cmd\r\n' }
      }
      throw new Error('not found')
    })
    const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    const dispatcher = {
      onRequest: vi.fn(
        (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
          requestHandlers.set(method, handler)
        }
      )
    }

    try {
      new PreflightHandler(dispatcher as never)
      const handler = requestHandlers.get('preflight.detectAgents')
      expect(handler).toBeDefined()
      await expect(
        handler!({
          commands: [
            {
              id: 'claude-agent-teams',
              cmd: 'orca',
              requiredCommands: ['claude'],
              unsupportedRuntimes: ['win32']
            },
            { id: 'claude', cmd: 'claude' }
          ]
        })
      ).resolves.toEqual({ agents: ['claude'] })
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('reports remote Windows shell capabilities through the SSH preflight path', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    isWslAvailableAsyncMock.mockResolvedValue(true)
    listWslDistrosAsyncMock.mockResolvedValue(['Ubuntu'])
    isPwshAvailableAsyncMock.mockResolvedValue(true)
    isGitBashAvailableMock.mockReturnValue(true)

    const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    const dispatcher = {
      onRequest: vi.fn(
        (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
          requestHandlers.set(method, handler)
        }
      )
    }

    new PreflightHandler(dispatcher as never)

    try {
      const handler = requestHandlers.get('preflight.detectWindowsTerminalCapabilities')
      expect(handler).toBeDefined()
      await expect(handler!({})).resolves.toEqual({
        wslAvailable: true,
        wslDistros: ['Ubuntu'],
        pwshAvailable: true,
        gitBashAvailable: true,
        hostPlatform: 'win32'
      })
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })
})
