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

function createTerminalHarness() {
  let registeredJoiner: ((text: string) => [number, number][]) | null = null
  const refresh = vi.fn()
  const deregisterCharacterJoiner = vi.fn()
  const terminal = {
    element: { style: {} },
    options: { fontFamily: 'Fira Code' },
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

  it('reuses joiner results for unchanged row text', () => {
    const harness = createTerminalHarness()
    new TerminalLigaturesAddon().activate(harness.terminal)
    const joiner = harness.getRegisteredJoiner()

    expect(joiner('a => b')).toEqual([[2, 4]])
    expect(joiner('a => b')).toEqual([[2, 4]])

    expect(addonMock.joiner).toHaveBeenCalledTimes(1)
  })

  it('returns fresh tuples because xterm mutates joiner ranges', () => {
    const harness = createTerminalHarness()
    new TerminalLigaturesAddon().activate(harness.terminal)
    const joiner = harness.getRegisteredJoiner()

    const first = joiner('a => b')
    first[0]![0] = 99

    expect(joiner('a => b')).toEqual([[2, 4]])
  })

  it('invalidates fallback results when font discovery refreshes', () => {
    const harness = createTerminalHarness()
    new TerminalLigaturesAddon().activate(harness.terminal)
    const joiner = harness.getRegisteredJoiner()
    joiner('a => b')

    addonMock.delegateTerminal!.refresh(0, 23)
    joiner('a => b')

    expect(harness.refresh).toHaveBeenCalledWith(0, 23)
    expect(addonMock.joiner).toHaveBeenCalledTimes(2)
  })

  it('does not reuse results after the terminal font changes', () => {
    const harness = createTerminalHarness()
    new TerminalLigaturesAddon().activate(harness.terminal)
    const joiner = harness.getRegisteredJoiner()
    joiner('a => b')

    harness.terminal.options.fontFamily = 'JetBrains Mono'
    joiner('a => b')

    expect(addonMock.joiner).toHaveBeenCalledTimes(2)
  })

  it('caps cached short segments by entry count', () => {
    const harness = createTerminalHarness()
    new TerminalLigaturesAddon().activate(harness.terminal)
    const joiner = harness.getRegisteredJoiner()

    for (let index = 0; index <= 2_048; index++) {
      joiner(`s${index}`)
    }
    joiner('s0')

    expect(addonMock.joiner).toHaveBeenCalledTimes(2_050)
  })

  it('evicts the least-recently-used segment', () => {
    const harness = createTerminalHarness()
    new TerminalLigaturesAddon().activate(harness.terminal)
    const joiner = harness.getRegisteredJoiner()

    for (let index = 0; index < 2_048; index++) {
      joiner(`s${index}`)
    }
    joiner('s0')
    joiner('new segment')
    joiner('s1')
    joiner('s0')

    expect(addonMock.joiner).toHaveBeenCalledTimes(2_050)
  })

  it('does not retain a segment above the character budget', () => {
    const harness = createTerminalHarness()
    new TerminalLigaturesAddon().activate(harness.terminal)
    const joiner = harness.getRegisteredJoiner()
    const oversizedSegment = 'x'.repeat(100_001)

    joiner(oversizedSegment)
    joiner(oversizedSegment)

    expect(addonMock.joiner).toHaveBeenCalledTimes(2)
  })

  it('deregisters the wrapped joiner through the real terminal', () => {
    const harness = createTerminalHarness()
    const addon = new TerminalLigaturesAddon()
    addon.activate(harness.terminal)

    addon.dispose()

    expect(harness.deregisterCharacterJoiner).toHaveBeenCalledWith(17)
  })
})
