import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { getCmdExePath } from './windows-batch-spawn'
import { buildWindowsHostInteractiveLoginSpawn } from './windows-interactive-login-spawn'

function withWindows<T>(fn: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
}

function encodedValue(value: string): string {
  return `Read-OrcaValue '${Buffer.from(value).toString('base64')}'`
}

/** Positional-independent so the argv shape can change without silently reading the wrong slot. */
function decodedScript(args: string[]): string {
  const payload = args[args.indexOf('-EncodedCommand') + 1] ?? ''
  return Buffer.from(payload, 'base64').toString('utf16le')
}

function pidFilePathFromSpawnArgs(args: string[]): string {
  const script = decodedScript(args)
  const encodedPath = script.match(
    /WriteAllText\(\(Read-OrcaValue '([^']+)'\), \[string\]\$PID\)/
  )?.[1]
  if (!encodedPath) {
    throw new Error('PID relay path is missing')
  }
  return Buffer.from(encodedPath, 'base64').toString('utf8')
}

function exitFilePathFromSpawnArgs(args: string[]): string {
  const encodedPath = decodedScript(args).match(
    /WriteAllText\(\(Read-OrcaValue '([^']+)'\), \[string\]\$ExitCode\)/
  )?.[1]
  if (!encodedPath) {
    throw new Error('Completion relay path is missing')
  }
  return Buffer.from(encodedPath, 'base64').toString('utf8')
}

describe('buildWindowsHostInteractiveLoginSpawn', () => {
  it('relays a batch login through a visible, PID-addressable console', () => {
    const spawn = withWindows(() =>
      buildWindowsHostInteractiveLoginSpawn('C:\\Tools\\claude.cmd', [
        'auth',
        'login',
        '--claudeai'
      ])
    )
    expect(spawn.command).toBe(getCmdExePath())
    expect(spawn.args.slice(0, 5)).toEqual(['/d', '/c', 'start', '', '/wait'])
    expect(spawn.args[5]).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
    // Why: `-ExecutionPolicy Bypass` is a no-op next to `-EncodedCommand` (only `-File` is
    // policy gated) and is a heavily EDR-flagged token, so it must not come back. The base64
    // must stay — `start` re-parses this through cmd.exe, whose safe-token guard rejects the
    // `&` and `"` in the raw relay script.
    expect(spawn.args.slice(6, 9)).toEqual(['-NoLogo', '-NoProfile', '-EncodedCommand'])
    expect(spawn.args).not.toContain('-ExecutionPolicy')
    expect(spawn.args).not.toContain('Bypass')

    const script = decodedScript(spawn.args)
    expect(script).toContain('[string]$PID')
    expect(script).toContain(encodedValue(getCmdExePath()))
    expect(script).toContain(encodedValue('C:\\Tools\\claude.cmd'))
    expect(script).toContain(encodedValue('--claudeai'))
    const pidFilePath = pidFilePathFromSpawnArgs(spawn.args)

    expect(spawn.stdio).toBe('ignore')
    expect(spawn.windowsHide).toBe(true)
    expect(spawn.getTerminationPid()).toBeNull()
    writeFileSync(pidFilePath, '2468')
    expect(spawn.getTerminationPid()).toBe(2468)
    spawn.cleanup()
    expect(existsSync(pidFilePath)).toBe(false)
  })

  it('routes executable logins through the same waiting console boundary', () => {
    const spawn = withWindows(() =>
      buildWindowsHostInteractiveLoginSpawn('C:\\Tools\\codex.exe', ['login'])
    )
    const script = decodedScript(spawn.args)
    expect(script).toContain(encodedValue('C:\\Tools\\codex.exe'))
    expect(script).toContain(encodedValue('login'))
    spawn.cleanup()
  })

  it('waits for the relay PID when cancellation races console startup', async () => {
    vi.useFakeTimers()
    const spawn = withWindows(() =>
      buildWindowsHostInteractiveLoginSpawn('C:\\Tools\\claude.exe', ['auth', 'login'])
    )
    try {
      const pendingPid = spawn.waitForTerminationPid()
      expect(spawn.getTerminationPid()).toBeNull()

      await vi.advanceTimersByTimeAsync(100)
      const pidFilePath = pidFilePathFromSpawnArgs(spawn.args)
      writeFileSync(pidFilePath, '8642')
      await vi.advanceTimersByTimeAsync(25)

      await expect(pendingPid).resolves.toBe(8642)
    } finally {
      spawn.cleanup()
      vi.useRealTimers()
    }
  })
})

describe('Windows login completion relay', () => {
  it.each([
    { text: undefined, code: null },
    { text: '', code: null },
    { text: '0', code: 0 },
    { text: '7', code: 7 },
    { text: '-1073741510', code: -1073741510 },
    { text: '4294967295', code: 4294967295 },
    { text: '7partial', code: null },
    { text: '0\n7', code: null },
    { text: '0.5', code: null },
    { text: '00', code: null },
    { text: 'NaN', code: null },
    { text: '4294967296', code: null },
    { text: '-2147483649', code: null }
  ])('requires a complete Windows exit code: $text', ({ text, code }) => {
    const spawn = withWindows(() =>
      buildWindowsHostInteractiveLoginSpawn('C:\\Tools\\codex.exe', ['login'])
    )
    const pidPath = pidFilePathFromSpawnArgs(spawn.args)
    const exitPath = exitFilePathFromSpawnArgs(spawn.args)
    writeFileSync(pidPath, '1234')
    if (text !== undefined) {
      writeFileSync(exitPath, text)
    }
    expect(spawn.getExitCode()).toBe(code)
    spawn.cleanup()
    expect(spawn.getExitCode()).toBe(code)
    expect(existsSync(pidPath)).toBe(false)
    expect(existsSync(exitPath)).toBe(false)
  })

  it('captures completion before cleanup removes the only evidence', () => {
    const spawn = withWindows(() =>
      buildWindowsHostInteractiveLoginSpawn('C:\\Tools\\codex.exe', ['login'])
    )
    writeFileSync(exitFilePathFromSpawnArgs(spawn.args), '7')
    spawn.cleanup()
    expect(spawn.getExitCode()).toBe(7)
  })

  it('keeps a captured verdict when relay cleanup fails', () => {
    const spawn = withWindows(() =>
      buildWindowsHostInteractiveLoginSpawn('C:\\Tools\\codex.exe', ['login'])
    )
    const exitPath = exitFilePathFromSpawnArgs(spawn.args)
    writeFileSync(exitPath, '7')
    expect(spawn.getExitCode()).toBe(7)
    rmSync(exitPath)
    mkdirSync(exitPath)
    try {
      expect(() => spawn.cleanup()).not.toThrow()
      expect(spawn.getExitCode()).toBe(7)
    } finally {
      rmSync(exitPath, { recursive: true, force: true })
    }
  })
})
