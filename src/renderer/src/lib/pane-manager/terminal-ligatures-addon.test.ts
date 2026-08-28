import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'

const addonMock = vi.hoisted(() => ({
  delegateTerminal: null as Terminal | null,
  joiner: vi.fn<(text: string) => [number, number][]>(),
  // Why a second joiner: the proxy once shared one cache across every joiner
  // it wrapped, so the first joiner's cached `[]` suppressed later joiners.
  secondJoiner: vi.fn<(text: string) => [number, number][]>()
}))

vi.mock('@xterm/addon-ligatures', () => ({
  LigaturesAddon: class {
    private readonly joinerIds: number[] = []

    activate(terminal: Terminal): void {
      addonMock.delegateTerminal = terminal
      // Why first: keeps getRegisteredJoiner() pointing at the ligature joiner.
      this.joinerIds.push(terminal.registerCharacterJoiner(addonMock.secondJoiner))
      this.joinerIds.push(terminal.registerCharacterJoiner(addonMock.joiner))
    }

    dispose(): void {
      for (const id of this.joinerIds) {
        addonMock.delegateTerminal?.deregisterCharacterJoiner(id)
      }
    }
  }
}))

import { TerminalLigaturesAddon } from './terminal-ligatures-addon'

function createTerminalHarness() {
  const registeredJoiners: Array<(text: string) => [number, number][]> = []
  const refresh = vi.fn()
  const deregisterCharacterJoiner = vi.fn()
  const terminal = {
    element: { style: {} },
    options: { fontFamily: 'Fira Code' },
    refresh,
    registerCharacterJoiner(joiner: (text: string) => [number, number][]): number {
      registeredJoiners.push(joiner)
      return 16 + registeredJoiners.length
    },
    deregisterCharacterJoiner
  } as unknown as Terminal
  return {
    terminal,
    refresh,
    deregisterCharacterJoiner,
    getRegisteredJoiner: () => registeredJoiners.at(-1)!,
    getRegisteredJoiners: () => registeredJoiners
  }
}

describe('TerminalLigaturesAddon', () => {
  beforeEach(() => {
    addonMock.delegateTerminal = null
    addonMock.joiner.mockReset()
    addonMock.joiner.mockImplementation((text) => (text.includes('=>') ? [[2, 4]] : []))
    addonMock.secondJoiner.mockReset()
    addonMock.secondJoiner.mockImplementation((text) => (text.includes('word') ? [[0, 4]] : []))
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

  it('deregisters the wrapped joiners through the real terminal', () => {
    const harness = createTerminalHarness()
    const addon = new TerminalLigaturesAddon()
    addon.activate(harness.terminal)

    addon.dispose()

    expect(harness.deregisterCharacterJoiner).toHaveBeenCalledWith(17)
    expect(harness.deregisterCharacterJoiner).toHaveBeenCalledWith(18)
  })

  it('does not let one cached [] suppress another joiner', () => {
    const harness = createTerminalHarness()
    new TerminalLigaturesAddon().activate(harness.terminal)
    const [second, ligature] = harness.getRegisteredJoiners()

    // The ligature joiner returns [] for this row and caches it…
    expect(ligature('word')).toEqual([])

    // …the second joiner must still run for the same row text.
    expect(second('word')).toEqual([[0, 4]])
    expect(addonMock.secondJoiner).toHaveBeenCalledTimes(1)

    // Per-joiner caching still applies within each joiner.
    second('word')
    expect(addonMock.secondJoiner).toHaveBeenCalledTimes(1)
  })

  it('clears every joiner’s cache on refresh', () => {
    const harness = createTerminalHarness()
    new TerminalLigaturesAddon().activate(harness.terminal)
    const [second, ligature] = harness.getRegisteredJoiners()
    second('word')
    ligature('word')

    addonMock.delegateTerminal!.refresh(0, 23)

    second('word')
    ligature('word')
    expect(addonMock.secondJoiner).toHaveBeenCalledTimes(2)
    expect(addonMock.joiner).toHaveBeenCalledTimes(2)
  })
})
