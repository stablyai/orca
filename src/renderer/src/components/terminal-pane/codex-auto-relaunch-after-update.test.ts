import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCodexAutoRelaunchAfterUpdate,
  isCodexForegroundProcessName
} from './codex-auto-relaunch-after-update'

async function flushAsyncTicks(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

describe('codex auto relaunch after update', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('recognizes Codex foreground process names across platforms', () => {
    expect(isCodexForegroundProcessName('codex')).toBe(true)
    expect(isCodexForegroundProcessName('codex.exe')).toBe(true)
    expect(isCodexForegroundProcessName('/opt/bin/codex-aarch64-ap')).toBe(true)
    expect(isCodexForegroundProcessName('zsh')).toBe(false)
    expect(isCodexForegroundProcessName(null)).toBe(false)
  })

  it('does not relaunch non-Codex startup commands', async () => {
    vi.useFakeTimers()
    const sendInput = vi.fn(() => true)
    const relaunch = createCodexAutoRelaunchAfterUpdate({
      startupCommand: 'claude',
      getPtyId: () => 'pty-1',
      inspectForegroundProcess: vi.fn().mockResolvedValue('zsh'),
      sendInput,
      isDisposed: () => false
    })

    relaunch.observeOutput('Update ran successfully! Please restart Codex.')
    vi.advanceTimersByTime(1_000)
    await flushAsyncTicks()

    expect(sendInput).not.toHaveBeenCalled()
  })

  it('relaunches the original Codex startup command after update success', async () => {
    vi.useFakeTimers()
    const sendInput = vi.fn(() => true)
    const relaunch = createCodexAutoRelaunchAfterUpdate({
      startupCommand: 'codex --profile work',
      getPtyId: () => 'pty-1',
      inspectForegroundProcess: vi.fn().mockResolvedValue('zsh'),
      sendInput,
      isDisposed: () => false
    })

    relaunch.observeOutput('Update ran successfully!')
    relaunch.observeOutput(' Please restart Codex.')
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()

    expect(sendInput).toHaveBeenCalledTimes(1)
    expect(sendInput).toHaveBeenCalledWith('codex --profile work\r')
  })

  it('waits until the foreground process leaves Codex', async () => {
    vi.useFakeTimers()
    let now = 0
    const sendInput = vi.fn(() => true)
    const inspectForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce('codex')
      .mockResolvedValueOnce('codex-aarch64-ap')
      .mockResolvedValueOnce('zsh')
    const relaunch = createCodexAutoRelaunchAfterUpdate({
      startupCommand: 'codex',
      getPtyId: () => 'pty-1',
      inspectForegroundProcess,
      sendInput,
      isDisposed: () => false,
      now: () => now
    })

    relaunch.observeOutput('Update ran successfully! Please restart Codex.')
    now += 250
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()
    expect(sendInput).not.toHaveBeenCalled()

    now += 250
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()
    expect(sendInput).not.toHaveBeenCalled()

    now += 250
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()

    expect(inspectForegroundProcess).toHaveBeenCalledTimes(3)
    expect(sendInput).toHaveBeenCalledWith('codex\r')
  })

  it('keeps polling when the PTY id is temporarily unavailable', async () => {
    vi.useFakeTimers()
    let now = 0
    let ptyId: string | null = null
    const sendInput = vi.fn(() => true)
    const inspectForegroundProcess = vi.fn().mockResolvedValue('zsh')
    const relaunch = createCodexAutoRelaunchAfterUpdate({
      startupCommand: 'codex',
      getPtyId: () => ptyId,
      inspectForegroundProcess,
      sendInput,
      isDisposed: () => false,
      now: () => now
    })

    relaunch.observeOutput('Update ran successfully! Please restart Codex.')
    now += 250
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()
    expect(inspectForegroundProcess).not.toHaveBeenCalled()
    expect(sendInput).not.toHaveBeenCalled()

    ptyId = 'pty-1'
    now += 250
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()

    expect(inspectForegroundProcess).toHaveBeenCalledWith('pty-1')
    expect(sendInput).toHaveBeenCalledWith('codex\r')
  })

  it('retries inspection errors instead of relaunching into a potentially active session', async () => {
    vi.useFakeTimers()
    let now = 0
    const sendInput = vi.fn(() => true)
    const inspectForegroundProcess = vi
      .fn()
      .mockRejectedValueOnce(new Error('inspection unavailable'))
      .mockResolvedValueOnce('codex')
      .mockResolvedValueOnce('zsh')
    const relaunch = createCodexAutoRelaunchAfterUpdate({
      startupCommand: 'codex',
      getPtyId: () => 'pty-1',
      inspectForegroundProcess,
      sendInput,
      isDisposed: () => false,
      now: () => now
    })

    relaunch.observeOutput('Update ran successfully! Please restart Codex.')
    now += 250
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()
    expect(sendInput).not.toHaveBeenCalled()

    now += 250
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()
    expect(sendInput).not.toHaveBeenCalled()

    now += 250
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()

    expect(inspectForegroundProcess).toHaveBeenCalledTimes(3)
    expect(sendInput).toHaveBeenCalledWith('codex\r')
  })

  it('retries when the relaunch input send is rejected', async () => {
    vi.useFakeTimers()
    let now = 0
    const sendInput = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const relaunch = createCodexAutoRelaunchAfterUpdate({
      startupCommand: 'codex',
      getPtyId: () => 'pty-1',
      inspectForegroundProcess: vi.fn().mockResolvedValue('zsh'),
      sendInput,
      isDisposed: () => false,
      now: () => now
    })

    relaunch.observeOutput('Update ran successfully! Please restart Codex.')
    now += 250
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()
    expect(sendInput).toHaveBeenCalledTimes(1)

    now += 250
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()

    expect(sendInput).toHaveBeenCalledTimes(2)
    expect(sendInput).toHaveBeenLastCalledWith('codex\r')
  })

  it('does not relaunch after disposal', async () => {
    vi.useFakeTimers()
    const sendInput = vi.fn(() => true)
    const relaunch = createCodexAutoRelaunchAfterUpdate({
      startupCommand: 'codex',
      getPtyId: () => 'pty-1',
      inspectForegroundProcess: vi.fn().mockResolvedValue('zsh'),
      sendInput,
      isDisposed: () => false
    })

    relaunch.observeOutput('Update ran successfully! Please restart Codex.')
    relaunch.dispose()
    vi.advanceTimersByTime(1_000)
    await flushAsyncTicks()

    expect(sendInput).not.toHaveBeenCalled()
  })
})
