import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from '../../../../shared/terminal-scrollback-limits'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { getUtf8ByteLength } from '../../../../shared/utf8-byte-limits'

const LEAF_ID = '11111111-1111-4111-8111-111111111111' as const
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222' as const

// Absolute cursor serialization adds a CUP suffix; mocks and byte limits must include its coordinates/bytes.
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

beforeEach(() => {
  mocks.flushTerminalOutput.mockReset()
})

const SINGLE_PANE_LAYOUT: TerminalLayoutSnapshot = {
  root: { type: 'leaf', leafId: LEAF_ID },
  activeLeafId: LEAF_ID,
  expandedLeafId: null
}

const SPLIT_ROOT: TerminalLayoutSnapshot['root'] = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: LEAF_ID },
  second: { type: 'leaf', leafId: LEAF_ID_2 }
}

describe('captureTerminalShutdownLayout', () => {
  it('uses the bounded native fit check without a separate JS byte scan', async () => {
    const byteLimits = await import('../../../../shared/utf8-byte-limits')
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const measure = vi.spyOn(byteLimits, 'measureUtf8ByteLength')
    const contents = 'x'.repeat(32 * 1024)
    const pane = {
      id: 1,
      leafId: LEAF_ID,
      terminal: mockTerminal(5_000),
      serializeAddon: { serialize: vi.fn(() => contents) }
    }
    try {
      const layout = captureTerminalShutdownLayout({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capture reads only the mocked pane fields.
        manager: { getPanes: () => [pane] } as never,
        paneTransports: new Map(),
        existingLayout: SINGLE_PANE_LAYOUT
      })
      expect(layout.buffersByLeafId).toEqual({ [LEAF_ID]: `${contents}${CURSOR_HOME}` })
      expect(pane.serializeAddon.serialize).toHaveBeenCalledExactlyOnceWith({ scrollback: 5_000 })
      expect(measure.mock.calls.length).toBe(0)
    } finally {
      measure.mockRestore()
    }
  })

  it.each(['x', 'é', '界', '😀', '\ud83d', '\udc00'])(
    'preserves exact-cap decisions and probe options for %j',
    async (unit) => {
      const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
      for (const delta of [-1, 0, 1]) {
        const payloadBytes =
          TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT + delta - CURSOR_HOME.length
        const unitBytes = Buffer.byteLength(unit)
        const contents =
          unit.repeat(Math.floor(payloadBytes / unitBytes)) + 'x'.repeat(payloadBytes % unitBytes)
        const serialize = vi.fn((options?: { scrollback?: number }) =>
          options?.scrollback === 5_000 ? contents : 'short'
        )
        const pane = Object.freeze({
          id: 1,
          leafId: LEAF_ID,
          terminal: mockTerminal(5_000),
          serializeAddon: { serialize }
        })
        const layout = captureTerminalShutdownLayout({
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capture reads only the mocked pane fields.
          manager: { getPanes: () => [pane] } as never,
          paneTransports: new Map(),
          existingLayout: SINGLE_PANE_LAYOUT
        })
        const expected = delta <= 0 ? contents : 'short'
        expect(layout.buffersByLeafId).toEqual({ [LEAF_ID]: `${expected}${CURSOR_HOME}` })
        expect(serialize.mock.calls.map(([options]) => options?.scrollback)).toEqual(
          delta <= 0 ? [5_000] : [5_000, 2_500, 3_750, 4_375, 4_687]
        )
      }
    }
  )

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
      getPanes: vi.fn(() => [pane])
    }
    mocks.flushTerminalOutput.mockImplementation((target: typeof terminal) => {
      expect(target).toBe(terminal)
      order.push('flush')
      terminal.pendingOutput = 'queued-before-quit'
    })

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      paneTransports: new Map([[1, { getPtyId: vi.fn(() => 'pty-1') }]]),
      existingLayout: {
        ...SINGLE_PANE_LAYOUT,
        titlesByLeafId: { [LEAF_ID]: 'build logs' },
        chatLeafId: LEAF_ID
      }
    })

    expect(order).toEqual(['flush', 'serialize'])
    expect(layout).toMatchObject<TerminalLayoutSnapshot>({
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      buffersByLeafId: { [LEAF_ID]: `snapshot:queued-before-quit${CURSOR_HOME}` },
      ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' },
      titlesByLeafId: { [LEAF_ID]: 'build logs' },
      chatLeafId: LEAF_ID
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
      getPanes: vi.fn(() => [pane])
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      paneTransports: new Map([[1, { getPtyId: vi.fn(() => 'pty-1') }]]),
      existingLayout: {
        root: SINGLE_PANE_LAYOUT.root,
        activeLeafId: null,
        expandedLeafId: null,
        titlesByLeafId: { [LEAF_ID]: 'local shell' },
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
      getPanes: vi.fn(() => [pane])
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      paneTransports: new Map([[1, { getPtyId: vi.fn(() => 'pty-1') }]]),
      existingLayout: SINGLE_PANE_LAYOUT
    })

    const buffer = layout.buffersByLeafId?.[LEAF_ID] ?? ''
    expect(buffer.length).toBeGreaterThan(0)
    expect(getUtf8ByteLength(buffer)).toBeLessThanOrEqual(
      TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT
    )
    // UTF-8 rows plus cursor suffix must fit together, reducing available history by one row here.
    const fittingRows = Math.floor(
      (TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT - CURSOR_HOME.length) / 2048
    )
    expect(buffer).toHaveLength(fittingRows * 1024 + CURSOR_HOME.length)
  })

  it('bounds serialize probes while capping an oversized buffer by UTF-8 bytes', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const multibyteRow = 'é'.repeat(1024)
    const serialize = vi.fn((options?: { scrollback?: number }) =>
      multibyteRow.repeat(options?.scrollback ?? 0)
    )
    const pane = {
      id: 1,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID,
      terminal: mockTerminal(512),
      serializeAddon: { serialize }
    }
    const manager = {
      getPanes: vi.fn(() => [pane])
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      paneTransports: new Map([[1, { getPtyId: vi.fn(() => 'pty-1') }]]),
      existingLayout: SINGLE_PANE_LAYOUT
    })

    // Full pass plus at most MAX_SCROLLBACK_FIT_PROBES fit probes; a bisection took 10+.
    expect(serialize.mock.calls.length).toBeLessThanOrEqual(5)
    expect(getUtf8ByteLength(layout.buffersByLeafId?.[LEAF_ID] ?? '')).toBeLessThanOrEqual(
      TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT
    )
  })

  it('keeps most of the byte budget when dense recent rows sit above sparse scrollback', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    // Dense recent rows over sparse history defeat pure secant convergence; test nonuniform byte density.
    const DENSE_ROWS = 1_000
    const DENSE_ROW = 'x'.repeat(600)
    const serialize = vi.fn((options?: { scrollback?: number }) => {
      const rows = options?.scrollback ?? 0
      const dense = Math.min(rows, DENSE_ROWS)
      return '.'.repeat(Math.max(rows - DENSE_ROWS, 0)) + DENSE_ROW.repeat(dense)
    })
    const pane = {
      id: 1,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID,
      terminal: mockTerminal(5_000),
      serializeAddon: { serialize }
    }
    const manager = {
      getPanes: vi.fn(() => [pane])
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      paneTransports: new Map([[1, { getPtyId: vi.fn(() => 'pty-1') }]]),
      existingLayout: SINGLE_PANE_LAYOUT
    })

    const bytes = getUtf8ByteLength(layout.buffersByLeafId?.[LEAF_ID] ?? '')
    expect(bytes).toBeLessThanOrEqual(TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT)
    expect(bytes).toBeGreaterThan(TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT * 0.9)
    expect(serialize.mock.calls.length).toBeLessThanOrEqual(5)
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
      getPanes: vi.fn(() => [pane])
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      paneTransports: new Map([[1, { getPtyId: vi.fn(() => 'pty-1') }]]),
      existingLayout: {
        root: SINGLE_PANE_LAYOUT.root,
        activeLeafId: null,
        expandedLeafId: null,
        titlesByLeafId: { [LEAF_ID]: 'local shell' },
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
      getPanes: vi.fn(() => [deadPane, livePane])
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      paneTransports: new Map([[2, { getPtyId: vi.fn(() => 'pty-live') }]]),
      existingLayout: {
        root: SPLIT_ROOT,
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
      getPanes: vi.fn(() => [firstPane, secondPane])
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      paneTransports: new Map([
        [1, { getPtyId: vi.fn(() => null) }],
        [2, { getPtyId: vi.fn(() => null) }]
      ]),
      existingLayout: {
        root: SPLIT_ROOT,
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
      getPanes: vi.fn(() => [paneWithoutPty, paneWithPty])
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      paneTransports: new Map([[2, { getPtyId: vi.fn(() => 'pty-2') }]]),
      existingLayout: { root: SPLIT_ROOT, activeLeafId: LEAF_ID, expandedLeafId: null }
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
      getPanes: vi.fn(() => [paneWithoutPty, paneWithPty])
    }

    const layout = captureTerminalShutdownLayout({
      manager: manager as never,
      paneTransports: new Map([[2, { getPtyId: vi.fn(() => 'pty-2') }]]),
      existingLayout: {
        root: SPLIT_ROOT,
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'stale-pty', [LEAF_ID_2]: 'pty-2' }
      }
    })

    expect(layout.activeLeafId).toBe(LEAF_ID_2)
    expect(layout.ptyIdsByLeafId).toEqual({ [LEAF_ID_2]: 'pty-2' })
  })
  it('keeps the stored structure instead of rebuilding it from the panes', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const panes = [LEAF_ID, LEAF_ID_2].map((leafId, index) => ({
      id: index + 1,
      leafId,
      stablePaneId: leafId,
      terminal: mockTerminal(1_000),
      serializeAddon: { serialize: vi.fn(() => '') }
    }))
    const existingLayout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEAF_ID },
        second: { type: 'leaf', leafId: LEAF_ID_2 },
        ratio: 0.3
      },
      activeLeafId: LEAF_ID_2,
      expandedLeafId: LEAF_ID_2,
      titlesByLeafId: { [LEAF_ID]: 'server' }
    }

    const layout = captureTerminalShutdownLayout({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capture reads only the mocked pane fields.
      manager: { getPanes: () => panes } as never,
      paneTransports: new Map([
        [1, { getPtyId: () => 'pty-1' }],
        [2, { getPtyId: () => 'pty-2' }]
      ]),
      existingLayout
    })

    expect(layout).toEqual({
      ...existingLayout,
      ptyIdsByLeafId: { [LEAF_ID]: 'pty-1', [LEAF_ID_2]: 'pty-2' }
    })
  })
  it('keeps the buffer and binding of a stored leaf whose pane is not mounted yet', async () => {
    const { captureTerminalShutdownLayout } = await import('./terminal-shutdown-layout-capture')
    const pane = {
      id: 1,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID,
      terminal: mockTerminal(1_000),
      serializeAddon: { serialize: vi.fn(() => 'mounted scrollback') }
    }

    const layout = captureTerminalShutdownLayout({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capture reads only the mocked pane fields.
      manager: { getPanes: () => [pane] } as never,
      paneTransports: new Map([[1, { getPtyId: () => 'pty-1' }]]),
      existingLayout: {
        root: SPLIT_ROOT,
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1', [LEAF_ID_2]: 'pty-2' },
        buffersByLeafId: { [LEAF_ID_2]: 'unmounted scrollback' },
        scrollbackRefsByLeafId: { [LEAF_ID_2]: 'v1-unmounted' }
      }
    })

    expect(layout.root).toEqual(SPLIT_ROOT)
    expect(layout.buffersByLeafId).toEqual({
      [LEAF_ID]: `mounted scrollback${CURSOR_HOME}`,
      [LEAF_ID_2]: 'unmounted scrollback'
    })
    expect(layout.scrollbackRefsByLeafId).toEqual({ [LEAF_ID_2]: 'v1-unmounted' })
    expect(layout.ptyIdsByLeafId).toEqual({ [LEAF_ID]: 'pty-1', [LEAF_ID_2]: 'pty-2' })
  })
})
