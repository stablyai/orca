import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/terminal/replay/terminal-scrollback-limits'
import type { TerminalLayoutSnapshot } from '../../../../../shared/workspace-layout/terminal-tab-types'
import '../../../../../shared/utf8-byte-limits'

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

vi.mock('@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler', () => ({
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
