import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from '../../../../shared/terminal-scrollback-limits'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import { getUtf8ByteLength } from '../../../../shared/utf8-byte-limits'

const LEAF_ID = '11111111-1111-4111-8111-111111111111' as const
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222' as const

// Why: capture now appends an absolute cursor restore (see
// terminal-serialize-absolute-cursor.ts), so pane mocks must expose the
// cursor fields and content expectations carry the home-position CUP suffix.
const CURSOR_HOME = '\x1b[1;1H'

function mockTerminal(scrollback: number): {
  options: { scrollback: number }
  cols: number
  rows: number
  buffer: { active: { cursorX: number; cursorY: number } }
} {
  return {
    options: { scrollback },
    cols: 80,
    rows: 24,
    buffer: { active: { cursorX: 0, cursorY: 0 } }
  }
}

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

function mockRootForSplit(firstPaneId = 1, secondPaneId = 2): HTMLDivElement {
  const first = new MockHTMLElement({
    classList: ['pane'],
    dataset: { paneId: String(firstPaneId), leafId: LEAF_ID },
    style: { flex: '1' }
  })
  const second = new MockHTMLElement({
    classList: ['pane'],
    dataset: { paneId: String(secondPaneId), leafId: LEAF_ID_2 },
    style: { flex: '1' }
  })
  const split = new MockHTMLElement({
    classList: ['pane-split'],
    children: [first, second]
  })
  return new MockHTMLElement({ firstElementChild: split }) as unknown as HTMLDivElement
}

describe('captureTerminalShutdownLayout', () => {
  it('flushes queued terminal output before serializing shutdown scrollback', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const order: string[] = []
    const terminal = {
      ...mockTerminal(1_000),
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
      buffersByLeafId: { [LEAF_ID]: `snapshot:queued-before-quit${CURSOR_HOME}` },
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
      terminal: mockTerminal(50_000),
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

  it('caps shutdown scrollback snapshots by UTF-8 bytes', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const multibyteRow = 'é'.repeat(1024)
    const pane = {
      id: 1,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID,
      terminal: mockTerminal(512),
      serializeAddon: {
        serialize: vi.fn((options?: { scrollback?: number }) =>
          multibyteRow.repeat(options?.scrollback ?? 0)
        )
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
      paneTitlesByPaneId: { 1: 'ssh shell' },
      existingLayout: undefined
    })

    const buffer = layout.buffersByLeafId?.[LEAF_ID] ?? ''
    expect(buffer.length).toBeGreaterThan(0)
    expect(getUtf8ByteLength(buffer)).toBeLessThanOrEqual(
      TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT
    )
    // Each 'e-acute' row is 2048 UTF-8 bytes; the CUP suffix joins the byte
    // accounting, so one fewer row fits than the bare limit would allow.
    const fittingRows = Math.floor(
      (TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT - CURSOR_HOME.length) / 2048
    )
    expect(buffer).toHaveLength(fittingRows * 1024 + CURSOR_HOME.length)
  })

  it('does not preserve prior scrollback buffers or refs for a cleared leaf', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const pane = {
      id: 1,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID,
      terminal: mockTerminal(1_000),
      serializeAddon: {
        serialize: vi.fn(() => '')
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
        buffersByLeafId: { [LEAF_ID]: 'previous-scrollback' },
        scrollbackRefsByLeafId: { [LEAF_ID]: 'v1-previous' }
      },
      clearedScrollbackLeafIds: new Set([LEAF_ID])
    })

    expect(layout.buffersByLeafId).toBeUndefined()
    expect(layout.scrollbackRefsByLeafId).toBeUndefined()
    expect(layout.ptyIdsByLeafId).toEqual({ [LEAF_ID]: 'pty-1' })
    expect(layout.titlesByLeafId).toEqual({ [LEAF_ID]: 'local shell' })
  })

  it('does not preserve stale prior PTY bindings as shutdown focus targets', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const deadPane = {
      id: 1,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID,
      terminal: mockTerminal(1_000),
      serializeAddon: {
        serialize: vi.fn(() => 'dead scrollback')
      }
    }
    const livePane = {
      id: 2,
      leafId: LEAF_ID_2,
      stablePaneId: LEAF_ID_2,
      terminal: mockTerminal(1_000),
      serializeAddon: {
        serialize: vi.fn(() => 'live scrollback')
      }
    }
    const manager = {
      getPanes: vi.fn(() => [deadPane, livePane]),
      getActivePane: vi.fn(() => deadPane)
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      container: mockRootForSplit(1, 2),
      expandedPaneId: null,
      paneTransports: new Map([[2, { getPtyId: vi.fn(() => 'pty-live') }]]),
      paneTitlesByPaneId: {},
      existingLayout: {
        root: null,
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-stale', [LEAF_ID_2]: 'pty-live' }
      }
    })

    expect(layout.activeLeafId).toBe(LEAF_ID_2)
    expect(layout.ptyIdsByLeafId).toEqual({ [LEAF_ID_2]: 'pty-live' })
    expect(layout.buffersByLeafId).toEqual({
      [LEAF_ID]: `dead scrollback${CURSOR_HOME}`,
      [LEAF_ID_2]: `live scrollback${CURSOR_HOME}`
    })
  })

  it('preserves prior PTY bindings while current pane transports are still attaching', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const firstPane = {
      id: 1,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID,
      terminal: mockTerminal(1_000),
      serializeAddon: {
        serialize: vi.fn(() => 'first scrollback')
      }
    }
    const secondPane = {
      id: 2,
      leafId: LEAF_ID_2,
      stablePaneId: LEAF_ID_2,
      terminal: mockTerminal(1_000),
      serializeAddon: {
        serialize: vi.fn(() => 'second scrollback')
      }
    }
    const manager = {
      getPanes: vi.fn(() => [firstPane, secondPane]),
      getActivePane: vi.fn(() => secondPane)
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      container: mockRootForSplit(1, 2),
      expandedPaneId: null,
      paneTransports: new Map([
        [1, { getPtyId: vi.fn(() => null) }],
        [2, { getPtyId: vi.fn(() => null) }]
      ]),
      paneTitlesByPaneId: {},
      existingLayout: {
        root: null,
        activeLeafId: LEAF_ID_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-first', [LEAF_ID_2]: 'pty-second' }
      }
    })

    expect(layout.activeLeafId).toBe(LEAF_ID_2)
    expect(layout.ptyIdsByLeafId).toEqual({
      [LEAF_ID]: 'pty-first',
      [LEAF_ID_2]: 'pty-second'
    })
  })

  it('does not persist a no-PTY pane as active when another split pane is bound', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const paneWithoutPty = {
      id: 1,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID,
      terminal: mockTerminal(1_000),
      serializeAddon: {
        serialize: vi.fn(() => '')
      }
    }
    const paneWithPty = {
      id: 2,
      leafId: LEAF_ID_2,
      stablePaneId: LEAF_ID_2,
      terminal: mockTerminal(1_000),
      serializeAddon: {
        serialize: vi.fn(() => '')
      }
    }
    const manager = {
      getPanes: vi.fn(() => [paneWithoutPty, paneWithPty]),
      getActivePane: vi.fn(() => paneWithoutPty)
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      container: mockRootForSplit(),
      expandedPaneId: null,
      paneTransports: new Map([[2, { getPtyId: vi.fn(() => 'pty-2') }]]),
      paneTitlesByPaneId: {},
      existingLayout: undefined
    })

    expect(layout.activeLeafId).toBe(LEAF_ID_2)
    expect(layout.ptyIdsByLeafId).toEqual({ [LEAF_ID_2]: 'pty-2' })
  })

  it('does not preserve a stale prior PTY binding for active shutdown focus', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const paneWithoutPty = {
      id: 1,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID,
      terminal: mockTerminal(1_000),
      serializeAddon: {
        serialize: vi.fn(() => '')
      }
    }
    const paneWithPty = {
      id: 2,
      leafId: LEAF_ID_2,
      stablePaneId: LEAF_ID_2,
      terminal: mockTerminal(1_000),
      serializeAddon: {
        serialize: vi.fn(() => '')
      }
    }
    const manager = {
      getPanes: vi.fn(() => [paneWithoutPty, paneWithPty]),
      getActivePane: vi.fn(() => paneWithoutPty)
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      container: mockRootForSplit(),
      expandedPaneId: null,
      paneTransports: new Map([[2, { getPtyId: vi.fn(() => 'pty-2') }]]),
      paneTitlesByPaneId: {},
      existingLayout: {
        root: null,
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'stale-pty', [LEAF_ID_2]: 'pty-2' }
      }
    })

    expect(layout.activeLeafId).toBe(LEAF_ID_2)
    expect(layout.ptyIdsByLeafId).toEqual({ [LEAF_ID_2]: 'pty-2' })
  })
})
