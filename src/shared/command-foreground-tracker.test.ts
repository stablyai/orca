import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandForegroundTracker } from './command-foreground-tracker'
import { FOREGROUND_COMMAND_READS } from './foreground-command-settle'

let foreground: string | null = 'zsh'
let available = true
let terminal: string | null = 'zsh'
const read = vi.fn(async () => ({ available, process: foreground }))
const readTerminalForeground = vi.fn(async () => terminal)
const tracker = (readsOnStart = false) =>
  new CommandForegroundTracker({
    read,
    readTerminalForeground,
    now: () => Date.now(),
    readsOnStart: () => readsOnStart
  })

beforeEach(() => {
  vi.useFakeTimers()
  read.mockClear()
  readTerminalForeground.mockClear()
  foreground = 'zsh'
  available = true
  terminal = 'zsh'
})
afterEach(() => vi.useRealTimers())

describe('CommandForegroundTracker', () => {
  it('reads only on reports, unless a consumer asks for the start ladder', async () => {
    const commands = tracker()
    commands.started('pty')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).not.toHaveBeenCalled()
    foreground = 'codex'
    commands.observeActivity('pty')
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledOnce()
  })

  it('names the agent its command ran, read on the start ladder', async () => {
    const commands = tracker(true)
    commands.started('pty')
    foreground = 'codex'
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    foreground = 'zsh'
    expect(commands.finished('pty')).toMatchObject({
      foreground: { kind: 'agent', agent: 'codex' }
    })
  })

  it("names the real foreground on a guest's event, whatever order agents report in (e2e i)", async () => {
    const commands = tracker()
    commands.started('pty')
    foreground = 'claude'
    // A detached Codex reports first: the read still sees Claude in the foreground.
    commands.observeActivity('pty')
    await vi.advanceTimersByTimeAsync(0)
    foreground = 'zsh'
    expect(commands.finished('pty')).toMatchObject({
      foreground: { kind: 'agent', agent: 'claude' }
    })
  })

  it('lets an agent that becomes foreground later win over a program before it', async () => {
    const commands = tracker(true)
    commands.started('pty')
    foreground = 'sleep'
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    foreground = 'codex'
    commands.observeActivity('pty')
    await vi.advanceTimersByTimeAsync(0)
    foreground = 'zsh'
    expect(commands.finished('pty')).toMatchObject({
      foreground: { kind: 'agent', agent: 'codex' }
    })
  })

  it('reports a program, or nothing when no read named the command', async () => {
    const commands = tracker(true)
    commands.started('a')
    foreground = 'ls'
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    foreground = 'zsh'
    expect(commands.finished('a')).toMatchObject({ foreground: { kind: 'program' } })
    available = false
    commands.started('b')
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    expect(commands.finished('b')).toMatchObject({ foreground: { kind: 'unknown' } })
    expect(commands.finished('never-started')).toMatchObject({ startedAt: null })
  })

  it('confirms the prompt returned from a fresh read, never the cached sampler (e2e iv, vi, ix)', async () => {
    const commands = tracker()
    commands.started('pty')
    // The cached sampler still names the exited (or Ctrl-Z-stopped) agent; the terminal does not.
    foreground = 'codex'
    const command = commands.finished('pty')
    expect(read).not.toHaveBeenCalled()
    await expect(command.promptReturned()).resolves.toBe(true)
    await expect(command.promptReturned()).resolves.toBe(true)
    expect(readTerminalForeground).toHaveBeenCalledOnce()
  })

  it('reports a leaked end while a non-shell still holds the terminal, and trusts an unreadable one', async () => {
    const commands = tracker()
    terminal = 'codex'
    await expect(commands.finished('pty').promptReturned()).resolves.toBe(false)
    terminal = null
    await expect(commands.finished('pty').promptReturned()).resolves.toBe(true)
    readTerminalForeground.mockRejectedValueOnce(new Error('ps failed'))
    await expect(commands.finished('pty').promptReturned()).resolves.toBe(true)
    const unreadable = new CommandForegroundTracker({ read, now: () => Date.now() })
    await expect(unreadable.finished('pty').promptReturned()).resolves.toBe(true)
  })
})
