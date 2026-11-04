import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'

const addonMock = vi.hoisted(() => ({
  delegateTerminal: null as Terminal | null,
  joiner: vi.fn<(text: string) => [number, number][]>()
}))

vi.mock('@xterm/addon-ligatures', () => ({
  LigaturesAddon: class {
    private joinerId: number | null = null

    activate(terminal: Terminal): void {
      addonMock.delegateTerminal = terminal
      this.joinerId = terminal.registerCharacterJoiner(addonMock.joiner)
    }

    dispose(): void {
      if (this.joinerId !== null) {
        addonMock.delegateTerminal?.deregisterCharacterJoiner(this.joinerId)
      }
    }
  }
}))

import { TerminalLigaturesAddon } from './terminal-ligatures-addon'

function createTerminalHarness(fontFamily = 'Fira Code') {
  let registeredJoiner: ((text: string) => [number, number][]) | null = null
  const refresh = vi.fn()
  const deregisterCharacterJoiner = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture provides every Terminal member the addon touches.
  const terminal = {
    element: { style: {} },
    options: { fontFamily },
    rows: 24,
    refresh,
    registerCharacterJoiner(joiner: (text: string) => [number, number][]): number {
      registeredJoiner = joiner
      return 17
    },
    deregisterCharacterJoiner
  } as unknown as Terminal
  return {
    terminal,
    refresh,
    deregisterCharacterJoiner,
    getRegisteredJoiner: () => registeredJoiner!
  }
}

describe('TerminalLigaturesAddon', () => {
  beforeEach(() => {
    addonMock.delegateTerminal = null
    addonMock.joiner.mockReset()
    addonMock.joiner.mockImplementation((text) => (text.includes('=>') ? [[2, 4]] : []))
  })

  it('returns fresh tuples because xterm mutates joiner ranges', () => {
    const harness = createTerminalHarness()
    new TerminalLigaturesAddon().activate(harness.terminal)
    const joiner = harness.getRegisteredJoiner()

    const first = joiner('a => b')
    first[0]![0] = 99

    expect(joiner('a => b')).toEqual([[2, 4]])
  })

  it('repaints every terminal sharing a font once that font loads', () => {
    const first = createTerminalHarness('Shared Mono')
    const second = createTerminalHarness('Shared Mono')
    new TerminalLigaturesAddon().activate(first.terminal)
    new TerminalLigaturesAddon().activate(second.terminal)
    first.getRegisteredJoiner()('a => b')
    second.getRegisteredJoiner()('a => b')

    // The addon refreshes its own terminal after parsing the font file.
    addonMock.delegateTerminal!.refresh(0, 0)

    expect(first.refresh).toHaveBeenCalledWith(0, 23)
    expect(second.refresh).toHaveBeenCalledWith(0, 23)
  })
})
