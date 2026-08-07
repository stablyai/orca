import { getHeapStatistics } from 'node:v8'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: true } }))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

const enabled = process.env.ORCA_TERMINAL_RETENTION_BENCH === '1'
const remainderChars = 1_000
const terminalCount = 8

function forceGc(): void {
  if (!global.gc) {
    throw new Error('run Node with --expose-gc')
  }
  for (let index = 0; index < 5; index += 1) {
    global.gc()
  }
}

function makeFlatTwoByteString(chars: number, seed: number): string {
  return JSON.parse(`"${String.fromCharCode(0x400 + seed).repeat(chars)}"`) as string
}

describe('terminal scheduler retained heap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.skipIf(!enabled)(
    'MANUAL ONLY: set ORCA_TERMINAL_RETENTION_BENCH=1 and run Node with --expose-gc',
    async () => {
      const scheduler = await import('./pane-terminal-output-scheduler')
      const sourceChars = scheduler.BACKGROUND_CHUNK_CHARS * 320 + remainderChars
      const terminals: { write(data: string, callback?: () => void): void }[] = []
      scheduler.configureTerminalOutputBacklogCap(50_000)
      forceGc()
      const baselineBytes = getHeapStatistics().used_heap_size

      for (let index = 0; index < terminalCount; index += 1) {
        const terminal = {
          write(_data: string, callback?: () => void) {
            callback?.()
          }
        }
        terminals.push(terminal)
        scheduler.writeTerminalOutput(
          terminal as never,
          makeFlatTwoByteString(sourceChars, index),
          {
            foreground: false
          }
        )
        scheduler.flushTerminalOutput(terminal as never, {
          maxChars: sourceChars - remainderChars
        })
      }

      forceGc()
      const partiallyDrainedBytes = getHeapStatistics().used_heap_size
      const retainedBytes = partiallyDrainedBytes - baselineBytes
      const debug = (
        globalThis as typeof globalThis & {
          __terminalOutputSchedulerDebug?: {
            snapshot(): { queuedChars: number; retainedChars: number }
          }
        }
      ).__terminalOutputSchedulerDebug
      const chargedChars = debug?.snapshot().retainedChars ?? 0
      const chargedBytes = chargedChars * 2
      // eslint-disable-next-line no-console -- manual retention probe evidence
      console.log(
        JSON.stringify({
          phase: 'partial',
          retainedBytes,
          chargedChars,
          chargedBytes,
          ratio: retainedBytes / chargedBytes
        })
      )
      expect(chargedChars).toBe(terminalCount * sourceChars)
      expect(Math.abs(retainedBytes - chargedBytes)).toBeLessThan(chargedBytes * 0.1)

      for (const terminal of terminals) {
        scheduler.flushTerminalOutput(terminal as never)
      }
      forceGc()
      const releasedBytes = partiallyDrainedBytes - getHeapStatistics().used_heap_size
      // eslint-disable-next-line no-console -- manual retention probe evidence
      console.log(JSON.stringify({ phase: 'released', releasedBytes, chargedBytes }))
      expect(releasedBytes).toBeGreaterThan(chargedBytes * 0.9)
      expect(debug?.snapshot()).toMatchObject({ queuedChars: 0, retainedChars: 0 })
    }
  )

  it.skipIf(!enabled)('MANUAL ONLY: measures retained-pressure rebase peak', async () => {
    const scheduler = await import('./pane-terminal-output-scheduler')
    const sourceChars = 2 * 1024 * 1024
    const terminal = {
      write(_data: string, callback?: () => void) {
        callback?.()
      }
    }
    let overlapBytes = 0
    let sourceLength = 0
    let copyLength = 0
    scheduler.configureTerminalOutputBacklogCap(1_000)
    forceGc()
    const baselineBytes = getHeapStatistics().used_heap_size

    scheduler.writeTerminalOutput(
      terminal as never,
      makeFlatTwoByteString(sourceChars, terminalCount),
      { foreground: true, latencySensitive: false }
    )
    scheduler.flushTerminalOutput(terminal as never, {
      maxChars: sourceChars - scheduler.BACKGROUND_CHUNK_CHARS
    })
    forceGc()
    const beforeRebaseBytes = getHeapStatistics().used_heap_size
    scheduler.setRetainedRebaseCopyObserverForTesting((source, copy) => {
      forceGc()
      overlapBytes = getHeapStatistics().used_heap_size
      sourceLength = source.length
      copyLength = copy.length
    })
    scheduler.writeTerminalOutput(terminal as never, makeFlatTwoByteString(1, terminalCount + 1), {
      foreground: true,
      latencySensitive: false
    })
    scheduler.setRetainedRebaseCopyObserverForTesting(null)
    forceGc()
    const afterRebaseBytes = getHeapStatistics().used_heap_size
    const debug = (
      globalThis as typeof globalThis & {
        __terminalOutputSchedulerDebug?: {
          snapshot(): { queuedChars: number; retainedChars: number }
        }
      }
    ).__terminalOutputSchedulerDebug
    // eslint-disable-next-line no-console -- manual retention probe evidence
    console.log(
      JSON.stringify({
        phase: 'rebase',
        beforeRebaseBytes: beforeRebaseBytes - baselineBytes,
        overlapBytes: overlapBytes - baselineBytes,
        afterRebaseBytes: afterRebaseBytes - baselineBytes,
        sourceLength,
        copyLength,
        chargedChars: debug?.snapshot().retainedChars ?? 0
      })
    )
    expect(sourceLength).toBe(sourceChars)
    expect(copyLength).toBe(scheduler.BACKGROUND_CHUNK_CHARS)
    expect(overlapBytes).toBeGreaterThan(beforeRebaseBytes)
    expect(afterRebaseBytes).toBeLessThan(overlapBytes)
    expect(debug?.snapshot()).toMatchObject({
      queuedChars: scheduler.BACKGROUND_CHUNK_CHARS + 1,
      retainedChars: scheduler.BACKGROUND_CHUNK_CHARS + 1
    })
  })
})
