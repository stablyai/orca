import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import {
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
