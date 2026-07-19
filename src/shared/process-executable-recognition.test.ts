import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, readlinkSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  readlinkSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

vi.mock('fs', () => ({
  readlinkSync: readlinkSyncMock
}))

import {
  readProcessExecutablePathCacheSizeForTests,
  recognizeAgentFromExecutablePath,
  resetProcessExecutablePathCacheForTests,
  resolveProcessExecutablePath
} from './process-executable-recognition'

// Why: the module wraps execFile with promisify, so the lsof mock must honor the
// Node callback contract — invoke the last arg with (err, { stdout, stderr }).
function mockLsof(stdout: string): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
    callback(null, { stdout, stderr: '' })
  })
}

describe('process-executable-recognition', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    readlinkSyncMock.mockReset()
    resetProcessExecutablePathCacheForTests()
  })

  afterEach(() => {
    resetProcessExecutablePathCacheForTests()
  })

  it('recognizes a renamed binary from the Linux /proc exe link', async () => {
    const readLinuxExecutable = vi.fn(async () => '/home/dev/.local/bin/grok')
    await expect(
      recognizeAgentFromExecutablePath(1234, 'my-cli --serve', {
        platform: 'linux',
        readLinuxExecutable
      })
    ).resolves.toEqual({ agent: 'grok', processName: 'grok' })
    expect(readLinuxExecutable).toHaveBeenCalledTimes(1)
  })

  it('reads /proc/PID/exe via the default Linux reader when none is injected', async () => {
    readlinkSyncMock.mockReturnValue('/home/dev/.local/bin/grok')
    await expect(resolveProcessExecutablePath(4242, { platform: 'linux' })).resolves.toBe(
      '/home/dev/.local/bin/grok'
    )
    expect(readlinkSyncMock).toHaveBeenCalledWith('/proc/4242/exe')
  })

  it('returns null when the default Linux reader throws (process exited mid-read)', async () => {
    readlinkSyncMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    await expect(resolveProcessExecutablePath(4243, { platform: 'linux' })).resolves.toBeNull()
  })

  it('recognizes a renamed binary from the macOS lsof executable image', async () => {
    // Why: `-d txt` lists the executable image first, then mapped dylibs; take
    // the first `n/…` line and ignore the rest.
    mockLsof(
      ['p4321', 'n/Users/dev/.local/bin/grok', 'n/usr/lib/dyld', 'n/usr/lib/libSystem.dylib'].join(
        '\n'
      )
    )
    await expect(
      recognizeAgentFromExecutablePath(4321, 'my-cli', { platform: 'darwin' })
    ).resolves.toEqual({
      agent: 'grok',
      processName: 'grok'
    })
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('lsof')
    expect(args).toEqual(['-a', '-p', '4321', '-d', 'txt', '-Fn'])
  })

  it('does not label a renamed headless one-shot as an interactive agent', async () => {
    // The real image is `claude`, but `--print` is a headless one-shot that the
    // command-aware guard rejects — basename-only recognition would mislabel it.
    await expect(
      recognizeAgentFromExecutablePath(2468, 'my-cli --print "summarize"', {
        platform: 'linux',
        readLinuxExecutable: async () => '/usr/local/bin/claude'
      })
    ).resolves.toBeNull()
  })

  it('does not label a generic orca invocation as claude-agent-teams', async () => {
    // Bare `orca` (no `claude-teams` subcommand) is not the agent TUI; the
    // command-aware guard preserves that, unlike basename-only recognition.
    await expect(
      recognizeAgentFromExecutablePath(1357, 'my-cli render', {
        platform: 'linux',
        readLinuxExecutable: async () => '/usr/local/bin/orca'
      })
    ).resolves.toBeNull()
  })

  it('recognizes a genuine orca claude-teams launch via its executable image', async () => {
    await expect(
      recognizeAgentFromExecutablePath(2469, 'my-cli claude-teams', {
        platform: 'linux',
        readLinuxExecutable: async () => '/usr/local/bin/orca'
      })
    ).resolves.toEqual({ agent: 'claude-agent-teams', processName: 'orca' })
  })

  it('caches the executable path per PID so a second call skips the reader', async () => {
    const readMacExecutable = vi.fn(async () => '/Users/dev/.local/bin/grok')
    const deps = { platform: 'darwin' as const, readMacExecutable }
    await expect(resolveProcessExecutablePath(777, deps)).resolves.toBe(
      '/Users/dev/.local/bin/grok'
    )
    await expect(resolveProcessExecutablePath(777, deps)).resolves.toBe(
      '/Users/dev/.local/bin/grok'
    )
    expect(readMacExecutable).toHaveBeenCalledTimes(1)
  })

  it('re-reads after the cache TTL expires', async () => {
    const readMacExecutable = vi.fn(async () => '/Users/dev/.local/bin/grok')
    let now = 0
    const deps = { platform: 'darwin' as const, readMacExecutable, now: () => now }
    await resolveProcessExecutablePath(888, deps)
    now = 5_001
    await resolveProcessExecutablePath(888, deps)
    expect(readMacExecutable).toHaveBeenCalledTimes(2)
  })

  it('does not fake an engine for an interpreter fork (node/python script)', async () => {
    await expect(
      recognizeAgentFromExecutablePath(555, 'my-worker', {
        platform: 'linux',
        readLinuxExecutable: async () => '/usr/local/bin/node'
      })
    ).resolves.toBeNull()
  })

  it('rejects a renamed headless one-shot even when argv0 is a quoted spaced path', async () => {
    // Why: a quoted path with an internal space must not split mid-path — the
    // dangling quote would otherwise swallow `--print`, bypassing the headless
    // guard and mislabeling the image as an interactive agent.
    await expect(
      recognizeAgentFromExecutablePath(
        3690,
        '"C:\\Program Files\\tools\\my launcher.exe" --print "summarize"',
        { platform: 'linux', readLinuxExecutable: async () => '/usr/local/bin/claude' }
      )
    ).resolves.toBeNull()
  })

  it('recognizes a genuine interactive agent behind a quoted spaced argv0', async () => {
    await expect(
      recognizeAgentFromExecutablePath(3691, '"C:\\Program Files\\tools\\my cli.exe" chat', {
        platform: 'linux',
        readLinuxExecutable: async () => '/usr/local/bin/claude'
      })
    ).resolves.toEqual({ agent: 'claude', processName: 'claude' })
  })

  it('recognizes orca claude-teams behind a quoted spaced argv0 (no false negative)', async () => {
    // Why: the naive split also dropped the `claude-teams` subcommand into a
    // dangling-quote token, making a genuine agent launch fail recognition.
    await expect(
      recognizeAgentFromExecutablePath(3692, '"C:\\Program Files\\x\\my orca.exe" claude-teams', {
        platform: 'linux',
        readLinuxExecutable: async () => '/usr/local/bin/orca'
      })
    ).resolves.toEqual({ agent: 'claude-agent-teams', processName: 'orca' })
  })

  it('bounds the cache: distinct never-reused PIDs do not accumulate past the cap', async () => {
    let now = 0
    const readLinuxExecutable = vi.fn(async () => '/usr/local/bin/node')
    const deps = { platform: 'linux' as const, readLinuxExecutable, now: () => now }
    // Fill past the soft cap with distinct PIDs, then advance beyond the TTL so
    // the next insert sweeps the expired entries instead of growing unbounded.
    for (let pid = 1; pid <= 512; pid += 1) {
      await resolveProcessExecutablePath(pid, deps)
    }
    now = 5_001 // past the 5s cache TTL so the next insert sweeps expired entries
    await resolveProcessExecutablePath(9999, deps)
    expect(readProcessExecutablePathCacheSizeForTests()).toBeLessThan(512)
  })

  it('returns null on unsupported platforms without invoking a reader', async () => {
    const readLinuxExecutable = vi.fn(async () => '/x/grok')
    const readMacExecutable = vi.fn(async () => '/x/grok')
    await expect(
      resolveProcessExecutablePath(9, { platform: 'win32', readLinuxExecutable, readMacExecutable })
    ).resolves.toBeNull()
    expect(readLinuxExecutable).not.toHaveBeenCalled()
    expect(readMacExecutable).not.toHaveBeenCalled()
  })
})
