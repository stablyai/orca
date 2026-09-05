import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  buildMuseExecArgs,
  executeMuseHeadless,
  isMuseHeadlessCommand,
  sanitizeLogOutput
} from './muse-headless-exec'
import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('muse agent registration and separation of modes', () => {
  it('recognizes muse as a valid TuiAgent', () => {
    expect(isTuiAgent('muse')).toBe(true)
    expect(TUI_AGENT_DISPLAY_NAMES.muse).toBe('Meta Muse')
  })

  it('uses interactive binary "muse" and NEVER "muse exec" as persistent launchCmd', () => {
    const config = TUI_AGENT_CONFIG.muse
    expect(config.launchCmd).toBe('muse')
    expect(config.detectCmd).toBe('muse')
    expect(config.expectedProcess).toBe('muse')
    expect(config.promptInjectionMode).toBe('argv')
    expect(config.argvPromptSeparator).toBe('--')
    expect(config.launchCmd).not.toContain('exec')
  })

  it('builds interactive TUI startup command with prompt and -- separator', () => {
    const plan = buildAgentStartupPlan({
      agent: 'muse',
      prompt: 'Fix the bug in parser',
      cmdOverrides: {},
      platform: 'linux'
    })
    expect(plan).not.toBeNull()
    expect(plan?.launchCommand).toBe("muse -- 'Fix the bug in parser'")
    expect(plan?.expectedProcess).toBe('muse')
  })

  it('distinguishes between interactive TUI and headless one-shot commands', () => {
    expect(isMuseHeadlessCommand('muse')).toBe(false)
    expect(isMuseHeadlessCommand('muse -- "prompt"')).toBe(false)
    expect(isMuseHeadlessCommand(['muse', '--', 'prompt'])).toBe(false)

    expect(isMuseHeadlessCommand('muse exec "prompt"')).toBe(true)
    expect(isMuseHeadlessCommand(['muse', 'exec', 'prompt'])).toBe(true)
    expect(isMuseHeadlessCommand(['exec', 'prompt'])).toBe(true)
  })
})

describe('muse headless one-shot execution', () => {
  it('builds structured argv array preserving spaces, quotes, and special characters', () => {
    const trickyPrompt = 'Fix issue #123: "unquoted" & $VAR `cmd` <stdio> \'single\''
    const argv = buildMuseExecArgs(trickyPrompt)
    expect(argv).toEqual(['exec', trickyPrompt])
  })

  it('appends extra flags before the positional prompt', () => {
    const argv = buildMuseExecArgs('run task', ['--provider', 'echo', '--yolo'])
    expect(argv).toEqual(['exec', '--provider', 'echo', '--yolo', 'run task'])
  })

  it('preserves cwd and passes structured argv to spawnFn', async () => {
    let capturedCommand = ''
    let capturedArgs: readonly string[] = []
    let capturedOptions: any = null

    const fakeChild = new EventEmitter() as any
    fakeChild.stdout = new PassThrough()
    fakeChild.stderr = new PassThrough()
    fakeChild.killed = false
    fakeChild.kill = vi.fn()

    const mockSpawn = ((command: string, args: readonly string[], options: any) => {
      capturedCommand = command
      capturedArgs = args
      capturedOptions = options
      setTimeout(() => {
        fakeChild.stdout.write('MUSE_OK\n')
        fakeChild.emit('close', 0, null)
      }, 5)
      return fakeChild
    }) as any

    const testCwd = 'C:\\test\\worktree'
    const result = await executeMuseHeadless({
      prompt: 'say MUSE_OK',
      cwd: testCwd,
      spawnFn: mockSpawn
    })

    expect(capturedCommand).toBe('muse')
    expect(capturedArgs).toEqual(['exec', 'say MUSE_OK'])
    expect(capturedOptions.cwd).toBe(testCwd)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('MUSE_OK')
  })

  it('captures exit code, stdout, and stderr on non-zero exit', async () => {
    const fakeChild = new EventEmitter() as any
    fakeChild.stdout = new PassThrough()
    fakeChild.stderr = new PassThrough()
    fakeChild.killed = false
    fakeChild.kill = vi.fn()

    const mockSpawn = (() => {
      setTimeout(() => {
        fakeChild.stderr.write('Task failed: syntax error\n')
        fakeChild.emit('close', 42, null)
      }, 5)
      return fakeChild
    }) as any

    const result = await executeMuseHeadless({
      prompt: 'invalid code',
      spawnFn: mockSpawn
    })

    expect(result.exitCode).toBe(42)
    expect(result.stderr).toContain('Task failed: syntax error')
  })

  it('reports a clear message when binary is missing (ENOENT)', async () => {
    const fakeChild = new EventEmitter() as any
    fakeChild.stdout = new PassThrough()
    fakeChild.stderr = new PassThrough()
    fakeChild.killed = false
    fakeChild.kill = vi.fn()

    const mockSpawn = (() => {
      setTimeout(() => {
        const enoentErr = Object.assign(new Error('spawn muse ENOENT'), { code: 'ENOENT' })
        fakeChild.emit('error', enoentErr)
      }, 5)
      return fakeChild
    }) as any

    await expect(
      executeMuseHeadless({
        prompt: 'test missing',
        spawnFn: mockSpawn
      })
    ).rejects.toThrow(/Meta Muse CLI \('muse'\) is not installed or not found on PATH/)
  })

  it('supports timeout and aborts execution', async () => {
    const fakeChild = new EventEmitter() as any
    fakeChild.stdout = new PassThrough()
    fakeChild.stderr = new PassThrough()
    fakeChild.killed = false
    fakeChild.kill = vi.fn(() => {
      fakeChild.killed = true
    })

    const mockSpawn = (() => fakeChild) as any

    await expect(
      executeMuseHeadless({
        prompt: 'slow task',
        timeoutMs: 20,
        spawnFn: mockSpawn
      })
    ).rejects.toThrow(/timed out after 20ms/)

    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('supports cancellation via AbortSignal', async () => {
    const fakeChild = new EventEmitter() as any
    fakeChild.stdout = new PassThrough()
    fakeChild.stderr = new PassThrough()
    fakeChild.killed = false
    fakeChild.kill = vi.fn(() => {
      fakeChild.killed = true
    })

    const controller = new AbortController()
    const mockSpawn = (() => fakeChild) as any

    const promise = executeMuseHeadless({
      prompt: 'cancellable task',
      signal: controller.signal,
      spawnFn: mockSpawn
    })

    controller.abort()

    await expect(promise).rejects.toThrow(/cancelled/)
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('sanitizes credentials and tokens from logs and stderr', () => {
    const rawError = 'Error: authentication failed for meta_api_key="EAABxyz1234567890abcdef" token=secret_token_1234567'
    const sanitized = sanitizeLogOutput(rawError)
    expect(sanitized).not.toContain('EAABxyz1234567890abcdef')
    expect(sanitized).not.toContain('secret_token_1234567')
    expect(sanitized).toContain('[SANITIZADO]')
  })
})
