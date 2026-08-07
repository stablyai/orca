import { TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS } from '../../../../shared/terminal-scrollback-policy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const FOREGROUND_BACKLOG_WARNING =
  '\x18\x1b[0m\r\n[Orca skipped a burst of terminal output because the backlog grew too large.]\r\n'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: true } }))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

type DebugSnapshot = {
  queuedChars: number
  retainedChars: number
  droppedBacklogCount: number
}

function createTerminal() {
  return {
    write: vi.fn((_data: string, callback?: () => void) => callback?.())
  }
}

async function loadScheduler() {
  vi.resetModules()
  return import('./pane-terminal-output-scheduler')
}

function readDebugSnapshot(): DebugSnapshot {
  return (
    globalThis as typeof globalThis & {
      __terminalOutputSchedulerDebug?: { snapshot(): DebugSnapshot }
    }
  ).__terminalOutputSchedulerDebug?.snapshot() as DebugSnapshot
}

function readOutput(terminal: ReturnType<typeof createTerminal>): string {
  return terminal.write.mock.calls.map(([data]) => data).join('')
}

describe('terminal scheduler retained-string charge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { __terminalOutputSchedulerDebug?: unknown })
      .__terminalOutputSchedulerDebug
    vi.unstubAllGlobals()
  })

  it('pins the background drain chunk size', async () => {
    const { BACKGROUND_CHUNK_CHARS } = await loadScheduler()

    expect(BACKGROUND_CHUNK_CHARS).toBe(16 * 1024)
  })

  it('separately charges pending output and an oversized retained source', async () => {
    const { BACKGROUND_CHUNK_CHARS, flushTerminalOutput, writeTerminalOutput } =
      await loadScheduler()
    const terminal = createTerminal()
    const source = 'x'.repeat(BACKGROUND_CHUNK_CHARS + 1_000)

    writeTerminalOutput(terminal as never, source, { foreground: false })
    flushTerminalOutput(terminal as never, { maxChars: BACKGROUND_CHUNK_CHARS })

    expect(terminal.write).toHaveBeenCalledWith(
      'x'.repeat(BACKGROUND_CHUNK_CHARS),
      expect.any(Function)
    )
    expect(readDebugSnapshot()).toMatchObject({
      queuedChars: 1_000,
      retainedChars: source.length
    })
  })

  it('advances through oversized source strings without duplicating drained data', async () => {
    const { BACKGROUND_CHUNK_CHARS, flushTerminalOutput, writeTerminalOutput } =
      await loadScheduler()
    const terminal = createTerminal()
    const source = `${'a'.repeat(BACKGROUND_CHUNK_CHARS)}${'b'.repeat(BACKGROUND_CHUNK_CHARS)}${'c'.repeat(BACKGROUND_CHUNK_CHARS)}${'d'.repeat(1_000)}`

    writeTerminalOutput(terminal as never, source, { foreground: false })
    for (let index = 0; index < 3; index += 1) {
      flushTerminalOutput(terminal as never, { maxChars: BACKGROUND_CHUNK_CHARS })
    }
    flushTerminalOutput(terminal as never)

    expect(readOutput(terminal)).toBe(source)
  })

  it('preserves two pending characters after draining an exact-cap source', async () => {
    const { configureTerminalOutputBacklogCap, flushTerminalOutput, writeTerminalOutput } =
      await loadScheduler()
    const terminal = createTerminal()
    const prefix = 'p'.repeat(TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS - 1)
    const firstPending = 'a'
    const secondPending = 'b'
    configureTerminalOutputBacklogCap(1_000)

    writeTerminalOutput(terminal as never, prefix, { foreground: false })
    writeTerminalOutput(terminal as never, firstPending, {
      foreground: true,
      latencySensitive: false
    })
    flushTerminalOutput(terminal as never, { maxChars: prefix.length })
    writeTerminalOutput(terminal as never, secondPending, {
      foreground: true,
      latencySensitive: false
    })
    flushTerminalOutput(terminal as never)

    expect(readOutput(terminal)).toBe(prefix + firstPending + secondPending)
  })

  it('preserves a 16 KiB live tail after draining an exact-cap source', async () => {
    const {
      BACKGROUND_CHUNK_CHARS,
      configureTerminalOutputBacklogCap,
      flushTerminalOutput,
      setRetainedRebaseCopyObserverForTesting,
      writeTerminalOutput
    } = await loadScheduler()
    const terminal = createTerminal()
    const liveTail = `${'t'.repeat(BACKGROUND_CHUNK_CHARS - 7)}A\ud83dB\ude00C😀`
    const source = `${'d'.repeat(
      TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS - BACKGROUND_CHUNK_CHARS
    )}${liveTail}`
    const appended = 'tail'
    const copyObserver = vi.fn()
    configureTerminalOutputBacklogCap(1_000)
    setRetainedRebaseCopyObserverForTesting(copyObserver)

    writeTerminalOutput(terminal as never, source, {
      foreground: true,
      latencySensitive: false
    })
    flushTerminalOutput(terminal as never, {
      maxChars: source.length - BACKGROUND_CHUNK_CHARS
    })
    expect(readDebugSnapshot()).toMatchObject({
      queuedChars: BACKGROUND_CHUNK_CHARS,
      retainedChars: source.length
    })
    writeTerminalOutput(terminal as never, appended, {
      foreground: true,
      latencySensitive: false
    })
    flushTerminalOutput(terminal as never)

    expect(readOutput(terminal)).toBe(source + appended)
    expect(copyObserver).toHaveBeenCalledTimes(1)
  })

  it('preserves pending output behind 63 consumed chunk references', async () => {
    const {
      BACKGROUND_CHUNK_CHARS,
      configureTerminalOutputBacklogCap,
      flushTerminalOutput,
      writeTerminalOutput
    } = await loadScheduler()
    const terminal = createTerminal()
    const prefixes = Array.from({ length: 63 }, (_, index) =>
      String(index).padEnd(BACKGROUND_CHUNK_CHARS, 'x')
    )
    const consumedPrefix = prefixes.join('')
    const firstPending = 'a'
    const appended = 'b'.repeat(TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS - consumedPrefix.length)
    configureTerminalOutputBacklogCap(1_000)

    for (const prefix of prefixes) {
      writeTerminalOutput(terminal as never, prefix, { foreground: false })
    }
    writeTerminalOutput(terminal as never, firstPending, {
      foreground: true,
      latencySensitive: false
    })
    flushTerminalOutput(terminal as never, { maxChars: consumedPrefix.length })
    writeTerminalOutput(terminal as never, appended, {
      foreground: true,
      latencySensitive: false
    })
    flushTerminalOutput(terminal as never)

    expect(readOutput(terminal)).toBe(consumedPrefix + firstPending + appended)
  })

  it.each([
    { drainedChars: 0, appendedChars: 0, drops: false },
    { drainedChars: 0, appendedChars: 1, drops: true },
    { drainedChars: 1, appendedChars: 1, drops: false },
    { drainedChars: 1, appendedChars: 2, drops: true },
    {
      drainedChars: TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS / 2,
      appendedChars: TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS / 2,
      drops: false
    },
    {
      drainedChars: TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS / 2,
      appendedChars: TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS / 2 + 1,
      drops: true
    }
  ])(
    'matches the legacy pending cap after draining $drainedChars and appending $appendedChars',
    async ({ drainedChars, appendedChars, drops }) => {
      const { configureTerminalOutputBacklogCap, flushTerminalOutput, writeTerminalOutput } =
        await loadScheduler()
      const terminal = createTerminal()
      const pendingChars = TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS - drainedChars
      configureTerminalOutputBacklogCap(1_000)

      if (drainedChars > 0) {
        writeTerminalOutput(terminal as never, 'd'.repeat(drainedChars), {
          foreground: false
        })
      }
      writeTerminalOutput(terminal as never, 'p'.repeat(pendingChars), {
        foreground: true,
        latencySensitive: false
      })
      if (drainedChars > 0) {
        flushTerminalOutput(terminal as never, { maxChars: drainedChars })
      }
      if (appendedChars > 0) {
        writeTerminalOutput(terminal as never, 'a'.repeat(appendedChars), {
          foreground: true,
          latencySensitive: false
        })
      }

      flushTerminalOutput(terminal as never)
      expect(readOutput(terminal)).toBe(
        drops
          ? `${'d'.repeat(drainedChars)}${FOREGROUND_BACKLOG_WARNING}`
          : `${'d'.repeat(drainedChars)}${'p'.repeat(pendingChars)}${'a'.repeat(appendedChars)}`
      )
      expect(readDebugSnapshot().droppedBacklogCount).toBe(drops ? 1 : 0)
    }
  )

  it('drops retained charges when compaction releases consumed prefix strings', async () => {
    const { BACKGROUND_CHUNK_CHARS, flushTerminalOutput, writeTerminalOutput } =
      await loadScheduler()
    const terminal = createTerminal()

    for (let index = 0; index < 65; index += 1) {
      writeTerminalOutput(terminal as never, String(index).padEnd(BACKGROUND_CHUNK_CHARS, 'x'), {
        foreground: false
      })
    }
    flushTerminalOutput(terminal as never, { maxChars: BACKGROUND_CHUNK_CHARS * 64 })

    expect(readDebugSnapshot()).toMatchObject({
      queuedChars: BACKGROUND_CHUNK_CHARS,
      retainedChars: BACKGROUND_CHUNK_CHARS
    })
  })

  it('bounds retained pressure and repeated rebase copies', async () => {
    const {
      BACKGROUND_CHUNK_CHARS,
      configureTerminalOutputBacklogCap,
      flushTerminalOutput,
      setRetainedRebaseCopyObserverForTesting,
      writeTerminalOutput
    } = await loadScheduler()
    const terminal = createTerminal()
    const configuredCapChars = 6_000_000
    const source = 'x'.repeat(configuredCapChars)
    const appended = 'a'.repeat(BACKGROUND_CHUNK_CHARS)
    const cycleCount = Math.ceil(configuredCapChars / BACKGROUND_CHUNK_CHARS)
    let copiedChars = 0
    configureTerminalOutputBacklogCap(50_000)
    setRetainedRebaseCopyObserverForTesting((_parent, copy) => {
      copiedChars += copy.length
    })

    writeTerminalOutput(terminal as never, source, {
      foreground: true,
      latencySensitive: false
    })
    for (let cycle = 0; cycle < cycleCount; cycle += 1) {
      flushTerminalOutput(terminal as never, { maxChars: BACKGROUND_CHUNK_CHARS })
      expect(readDebugSnapshot().retainedChars).toBeLessThan(configuredCapChars * 2)
      writeTerminalOutput(terminal as never, appended, {
        foreground: true,
        latencySensitive: false
      })
      const snapshot = readDebugSnapshot()
      expect(snapshot.retainedChars).toBeLessThanOrEqual(
        Math.max(configuredCapChars, snapshot.queuedChars * 2)
      )
      expect(snapshot.retainedChars).toBeLessThan(configuredCapChars * 2)
    }
    flushTerminalOutput(terminal as never)

    expect(readOutput(terminal)).toBe(source + appended.repeat(cycleCount))
    expect(copiedChars).toBeGreaterThan(0)
    expect(copiedChars).toBeLessThanOrEqual(source.length * 2)
  })

  it('does not copy an unconsumed indivisible chunk above the cap', async () => {
    const {
      configureTerminalOutputBacklogCap,
      flushTerminalOutput,
      setRetainedRebaseCopyObserverForTesting,
      writeTerminalOutput
    } = await loadScheduler()
    const terminal = createTerminal()
    const source = 'x'.repeat(TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS + 1)
    const copyObserver = vi.fn()
    configureTerminalOutputBacklogCap(1_000)
    setRetainedRebaseCopyObserverForTesting(copyObserver)

    writeTerminalOutput(terminal as never, source, {
      foreground: true,
      latencySensitive: false
    })
    flushTerminalOutput(terminal as never)

    expect(readOutput(terminal)).toBe(FOREGROUND_BACKLOG_WARNING)
    expect(copyObserver).not.toHaveBeenCalled()
  })

  it('releases the full retained charge after partial-first prefix compaction', async () => {
    const { BACKGROUND_CHUNK_CHARS, flushTerminalOutput, writeTerminalOutput } =
      await loadScheduler()
    const terminal = createTerminal()
    const partiallyDrained = 'p'.repeat(BACKGROUND_CHUNK_CHARS * 2)
    const consumedPrefixes = Array.from({ length: 63 }, (_, index) =>
      String(index).padEnd(BACKGROUND_CHUNK_CHARS, 'x')
    )
    const survivor = 's'.repeat(BACKGROUND_CHUNK_CHARS)
    const source = partiallyDrained + consumedPrefixes.join('') + survivor

    writeTerminalOutput(terminal as never, partiallyDrained, { foreground: false })
    flushTerminalOutput(terminal as never, { maxChars: 1 })
    for (const prefix of consumedPrefixes) {
      writeTerminalOutput(terminal as never, prefix, { foreground: false })
    }
    writeTerminalOutput(terminal as never, survivor, { foreground: false })
    flushTerminalOutput(terminal as never, {
      maxChars: BACKGROUND_CHUNK_CHARS * 64 - 1
    })

    expect(readDebugSnapshot()).toMatchObject({
      queuedChars: BACKGROUND_CHUNK_CHARS,
      retainedChars: BACKGROUND_CHUNK_CHARS,
      droppedBacklogCount: 0
    })
    flushTerminalOutput(terminal as never)
    expect(readOutput(terminal)).toBe(source)
  })

  it('charges consumed prefixes as retained until compaction releases them', async () => {
    const {
      BACKGROUND_CHUNK_CHARS,
      discardTerminalOutput,
      flushTerminalOutput,
      writeTerminalOutput
    } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal as never, 'a'.repeat(BACKGROUND_CHUNK_CHARS), {
      foreground: false
    })
    writeTerminalOutput(terminal as never, 'b'.repeat(BACKGROUND_CHUNK_CHARS), {
      foreground: true,
      latencySensitive: false
    })
    flushTerminalOutput(terminal as never, { maxChars: BACKGROUND_CHUNK_CHARS })

    expect(readDebugSnapshot()).toMatchObject({
      queuedChars: BACKGROUND_CHUNK_CHARS,
      retainedChars: BACKGROUND_CHUNK_CHARS * 2
    })
    discardTerminalOutput(terminal as never)
    expect(readDebugSnapshot()).toMatchObject({ queuedChars: 0, retainedChars: 0 })
  })
})
