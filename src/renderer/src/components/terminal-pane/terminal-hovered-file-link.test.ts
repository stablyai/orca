import type { Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setHoveredTerminalFileLink,
  terminalFileLinkRevealAtMouseEvent,
  type TerminalFileLinkReveal
} from './terminal-hovered-file-link'

const storeState = vi.hoisted((): { settings: { activeRuntimeEnvironmentId: string | null } } => ({
  settings: { activeRuntimeEnvironmentId: null }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => storeState }
}))

const CELL = 10
const localTransport = { getPtyId: () => 'pty-1' }
const hoveredLink = {
  path: '/repo/src/foo.ts',
  range: { start: { x: 7, y: 3 }, end: { x: 16, y: 3 } },
  clientOsCanOpen: true
}
const revealed = { path: '/repo/src/foo.ts', blocked: false }
const blocked = { path: '/repo/src/foo.ts', blocked: true }

function makeTerminal(viewportY = 0): Terminal {
  const screen = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 80 * CELL, height: 24 * CELL })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only these fields.
  return {
    cols: 80,
    rows: 24,
    element: { querySelector: () => screen },
    buffer: { active: { viewportY } }
  } as unknown as Terminal
}

/** A right-click on 1-based viewport cell (column, row). */
function rightClickAt(column: number, row: number): MouseEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the pointer coordinates are read.
  return { clientX: (column - 1) * CELL + 1, clientY: (row - 1) * CELL + 1 } as MouseEvent
}

function revealAt(
  terminal: Terminal,
  column: number,
  row: number,
  transport: Parameters<typeof terminalFileLinkRevealAtMouseEvent>[2] = localTransport
): TerminalFileLinkReveal | null {
  return terminalFileLinkRevealAtMouseEvent(terminal, rightClickAt(column, row), transport)
}

describe('terminalFileLinkRevealAtMouseEvent', () => {
  beforeEach(() => {
    storeState.settings = { activeRuntimeEnvironmentId: null }
  })

  it('returns the hovered link when the right-click lands on it', () => {
    const terminal = makeTerminal()
    setHoveredTerminalFileLink(terminal, hoveredLink)

    expect(revealAt(terminal, 7, 3)).toEqual(revealed)
    expect(revealAt(terminal, 16, 3)).toEqual(revealed)
  })

  it('ignores a right-click beside the hovered link', () => {
    const terminal = makeTerminal()
    setHoveredTerminalFileLink(terminal, hoveredLink)

    expect(revealAt(terminal, 17, 3)).toBeNull()
    expect(revealAt(terminal, 7, 4)).toBeNull()
  })

  it('ignores a hovered link that scrolled away from under the pointer', () => {
    const terminal = makeTerminal(5)
    setHoveredTerminalFileLink(terminal, hoveredLink)

    expect(revealAt(terminal, 7, 3)).toBeNull()
  })

  it('returns nothing once the pointer has left the link', () => {
    const terminal = makeTerminal()
    setHoveredTerminalFileLink(terminal, hoveredLink)
    setHoveredTerminalFileLink(terminal, null)

    expect(revealAt(terminal, 7, 3)).toBeNull()
  })

  it('keeps each terminal to its own hovered link', () => {
    const hovered = makeTerminal()
    const other = makeTerminal()
    setHoveredTerminalFileLink(hovered, hoveredLink)

    expect(revealAt(other, 7, 3)).toBeNull()
  })

  it('blocks a path printed by an SSH or remote-runtime pane', () => {
    const terminal = makeTerminal()
    setHoveredTerminalFileLink(terminal, hoveredLink)

    expect(
      revealAt(terminal, 7, 3, { getPtyId: () => 'pty-1', getConnectionId: () => 'ssh-1' })
    ).toEqual(blocked)
    expect(
      revealAt(terminal, 7, 3, { getPtyId: () => 'pty-1', getRuntimeEnvironmentId: () => 'env-1' })
    ).toEqual(blocked)
  })

  it('blocks a path in a worktree whose files live on another host', () => {
    const terminal = makeTerminal()
    setHoveredTerminalFileLink(terminal, { ...hoveredLink, clientOsCanOpen: false })

    expect(revealAt(terminal, 7, 3)).toEqual(blocked)
  })

  it('blocks every path while a remote runtime is focused, since the OS reveal is refused', () => {
    const terminal = makeTerminal()
    setHoveredTerminalFileLink(terminal, hoveredLink)
    storeState.settings = { activeRuntimeEnvironmentId: 'env-1' }

    expect(revealAt(terminal, 7, 3)).toEqual(blocked)
  })

  describe('a link whose file is not yet known to exist', () => {
    it('is offered only once the file is found', async () => {
      const terminal = makeTerminal()
      setHoveredTerminalFileLink(terminal, hoveredLink, Promise.resolve(true))

      expect(revealAt(terminal, 7, 3)).toBeNull()
      await Promise.resolve()
      expect(revealAt(terminal, 7, 3)).toEqual(revealed)
    })

    it.each([
      ['is missing', () => Promise.resolve(false)],
      ['cannot be checked', () => Promise.reject<boolean>(new Error('host unreachable'))]
    ])('is never offered when the file %s', async (_case, exists) => {
      const terminal = makeTerminal()
      setHoveredTerminalFileLink(terminal, hoveredLink, exists())

      await Promise.resolve()
      expect(revealAt(terminal, 7, 3)).toBeNull()
    })

    it('stays forgotten when the answer arrives after the pointer has left', async () => {
      const terminal = makeTerminal()
      setHoveredTerminalFileLink(terminal, hoveredLink, Promise.resolve(true))
      setHoveredTerminalFileLink(terminal, null)

      await Promise.resolve()
      expect(revealAt(terminal, 7, 3)).toBeNull()
    })

    it('does not vouch for the link hovered after it', async () => {
      const terminal = makeTerminal()
      setHoveredTerminalFileLink(terminal, hoveredLink, Promise.resolve(true))
      setHoveredTerminalFileLink(terminal, hoveredLink, Promise.resolve(false))

      await Promise.resolve()
      expect(revealAt(terminal, 7, 3)).toBeNull()
    })
  })
})
