import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/e2e-config', () => ({
  e2eConfig: { exposeStore: false }
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

const ASCII_ALLOCATION_SIZES = [1024, 1024 * 1024, 2 * 1024 * 1024] as const

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
})

describe('renderer memory attribution', () => {
  it.each(ASCII_ALLOCATION_SIZES)(
    'reports a retained ASCII terminal queue of %i characters',
    async (retainedChars) => {
      vi.useFakeTimers()
      vi.resetModules()
      const { collectRendererMemoryProfile } = await import('./renderer-memory-profile')
      const { discardTerminalOutput, writeTerminalOutput } =
        await import('./pane-manager/pane-terminal-output-scheduler')
      const terminal = { write: vi.fn() }
      cleanup = () => discardTerminalOutput(terminal)

      writeTerminalOutput(terminal, 'x'.repeat(retainedChars), { foreground: false })

      expect(collectRendererMemoryProfile()).toMatchObject({
        counts: {
          'terminalOutputQueue.queuedChars': retainedChars
        },
        onHeapHeuristicByCategoryKB: {
          'terminalOutputQueue.onHeapHeuristicKB': Math.ceil((retainedChars * 2) / 1024)
        }
      })

      cleanup()
      cleanup = undefined
      expect(collectRendererMemoryProfile()).toMatchObject({
        counts: { 'terminalOutputQueue.queuedChars': 0 },
        onHeapHeuristicByCategoryKB: {
          'terminalOutputQueue.onHeapHeuristicKB': 0
        }
      })
    }
  )
})
