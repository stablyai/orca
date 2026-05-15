import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'

const LEAF_ID = '11111111-1111-4111-8111-111111111111' as const

const mocks = vi.hoisted(() => ({
  flushTerminalOutput: vi.fn()
}))

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: mocks.flushTerminalOutput
}))

class MockHTMLElement {
  classList: { contains: (cls: string) => boolean }
  dataset: Record<string, string>
  children: MockHTMLElement[]
  style: Record<string, string>
  firstElementChild: MockHTMLElement | null

  constructor(opts: {
    classList?: string[]
    dataset?: Record<string, string>
    children?: MockHTMLElement[]
    style?: Record<string, string>
    firstElementChild?: MockHTMLElement | null
  }) {
    const classes = opts.classList ?? []
    this.classList = { contains: (cls: string) => classes.includes(cls) }
    this.dataset = opts.dataset ?? {}
    this.children = opts.children ?? []
    this.style = opts.style ?? {}
    this.firstElementChild = opts.firstElementChild ?? null
  }
}

beforeAll(() => {
  ;(globalThis as unknown as Record<string, unknown>).HTMLElement = MockHTMLElement
})

beforeEach(() => {
  mocks.flushTerminalOutput.mockReset()
})

function mockRootForPane(paneId: number, leafId: string = LEAF_ID): HTMLDivElement {
  const pane = new MockHTMLElement({
    classList: ['pane'],
    dataset: { paneId: String(paneId), leafId }
  })
  return new MockHTMLElement({ firstElementChild: pane }) as unknown as HTMLDivElement
}

describe('captureTerminalShutdownLayout', () => {
  it('flushes queued terminal output before serializing shutdown scrollback', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const order: string[] = []
    const terminal = {
      options: { scrollback: 1_000 },
      pendingOutput: ''
    }
    const pane = {
      id: 1,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID,
      terminal,
      serializeAddon: {
        serialize: vi.fn(() => {
          order.push('serialize')
          return `snapshot:${terminal.pendingOutput}`
        })
      }
    }
    const manager = {
      getPanes: vi.fn(() => [pane]),
      getActivePane: vi.fn(() => pane)
    }
    mocks.flushTerminalOutput.mockImplementation((target: typeof terminal) => {
      expect(target).toBe(terminal)
      order.push('flush')
      terminal.pendingOutput = 'queued-before-quit'
    })

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      container: mockRootForPane(1, LEAF_ID),
      expandedPaneId: null,
      paneTransports: new Map([[1, { getPtyId: vi.fn(() => 'pty-1') }]]),
      paneTitlesByPaneId: { 1: 'build logs' },
      existingLayout: undefined
    })

    expect(order).toEqual(['flush', 'serialize'])
    expect(layout).toMatchObject<TerminalLayoutSnapshot>({
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      buffersByLeafId: { [LEAF_ID]: 'snapshot:queued-before-quit' },
      ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' },
      titlesByLeafId: { [LEAF_ID]: 'build logs' }
    })
  })

  it('skips local shutdown scrollback serialization while preserving layout metadata', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const pane = {
      id: 1,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID,
      terminal: { options: { scrollback: 50_000 } },
      serializeAddon: {
        serialize: vi.fn(() => 'x'.repeat(512 * 1024))
      }
    }
    const manager = {
      getPanes: vi.fn(() => [pane]),
      getActivePane: vi.fn(() => pane)
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      container: mockRootForPane(1),
      expandedPaneId: null,
      paneTransports: new Map([[1, { getPtyId: vi.fn(() => 'pty-1') }]]),
      paneTitlesByPaneId: { 1: 'local shell' },
      existingLayout: {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        buffersByLeafId: { [LEAF_ID]: 'previous-local-scrollback' }
      },
      captureBuffers: false
    })

    expect(mocks.flushTerminalOutput).not.toHaveBeenCalled()
    expect(pane.serializeAddon.serialize).not.toHaveBeenCalled()
    expect(layout.buffersByLeafId).toBeUndefined()
    expect(layout.ptyIdsByLeafId).toEqual({ [LEAF_ID]: 'pty-1' })
    expect(layout.titlesByLeafId).toEqual({ [LEAF_ID]: 'local shell' })
  })
})
