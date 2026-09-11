import { describe, expect, it } from 'vitest'
import { attachTerminalAlternateScrollModeTracking } from './terminal-alternate-scroll-mode'

type CsiKey = string
type Handlers = {
  csi: Map<CsiKey, (params: (number | number[])[]) => boolean>
  esc: Map<string, () => boolean>
  disposed: string[]
}

// Why enforced here: xterm's EscapeSequenceParser throws on an out-of-range
// identifier byte, and that throw lands in a React render. A permissive fake
// would let a misplaced prefix/intermediate reach the app.
function assertIdentifierBytes(id: {
  prefix?: string
  intermediates?: string
  final: string
}): void {
  const inRange = (value: string, low: number, high: number) =>
    [...value].every((char) => char.charCodeAt(0) >= low && char.charCodeAt(0) <= high)
  if (id.prefix !== undefined && !inRange(id.prefix, 0x3c, 0x3f)) {
    throw new Error('prefix must be in range 0x3c .. 0x3f')
  }
  if (id.intermediates !== undefined && !inRange(id.intermediates, 0x20, 0x2f)) {
    throw new Error('intermediate must be in range 0x20 .. 0x2f')
  }
  if (!inRange(id.final, 0x40, 0x7e)) {
    throw new Error('final must be in range 0x40 .. 0x7e')
  }
}

function fakeTerminal(): {
  terminal: Parameters<typeof attachTerminalAlternateScrollModeTracking>[0]
  handlers: Handlers
} {
  const handlers: Handlers = { csi: new Map(), esc: new Map(), disposed: [] }
  const terminal = {
    parser: {
      registerCsiHandler: (
        id: { prefix?: string; intermediates?: string; final: string },
        handler: (params: (number | number[])[]) => boolean
      ) => {
        assertIdentifierBytes(id)
        const key = `${id.prefix ?? ''}${id.intermediates ?? ''}${id.final}`
        handlers.csi.set(key, handler)
        return { dispose: () => handlers.disposed.push(key) }
      },
      registerEscHandler: (id: { final: string }, handler: () => boolean) => {
        assertIdentifierBytes(id)
        handlers.esc.set(id.final, handler)
        return { dispose: () => handlers.disposed.push(`esc:${id.final}`) }
      }
    }
  }
  return { terminal, handlers }
}

describe('terminal alternate scroll mode (DECSET 1007)', () => {
  it('reports no preference until the app sets the mode', () => {
    const { terminal } = fakeTerminal()
    expect(attachTerminalAlternateScrollModeTracking(terminal).appPreference()).toBeUndefined()
  })

  it('tracks the mode being set and reset', () => {
    const { terminal, handlers } = fakeTerminal()
    const tracked = attachTerminalAlternateScrollModeTracking(terminal)

    expect(handlers.csi.get('?h')?.([1007])).toBe(false)
    expect(tracked.appPreference()).toBe(true)

    expect(handlers.csi.get('?l')?.([1007])).toBe(false)
    expect(tracked.appPreference()).toBe(false)
  })

  it('reads the mode out of a combined private-mode sequence', () => {
    const { terminal, handlers } = fakeTerminal()
    const tracked = attachTerminalAlternateScrollModeTracking(terminal)

    handlers.csi.get('?h')?.([1049, 1007])
    expect(tracked.appPreference()).toBe(true)
  })

  it('ignores private modes it does not own', () => {
    const { terminal, handlers } = fakeTerminal()
    const tracked = attachTerminalAlternateScrollModeTracking(terminal)

    handlers.csi.get('?h')?.([1049, 1000, 1006])
    expect(tracked.appPreference()).toBeUndefined()
  })

  it('clears the preference on a full reset so it cannot outlive the process', () => {
    const { terminal, handlers } = fakeTerminal()
    const tracked = attachTerminalAlternateScrollModeTracking(terminal)

    handlers.csi.get('?h')?.([1007])
    expect(handlers.esc.get('c')?.()).toBe(false)
    expect(tracked.appPreference()).toBeUndefined()
  })

  it('clears the preference on a soft reset', () => {
    const { terminal, handlers } = fakeTerminal()
    const tracked = attachTerminalAlternateScrollModeTracking(terminal)

    handlers.csi.get('?l')?.([1007])
    expect(handlers.csi.get('!p')?.([])).toBe(false)
    expect(tracked.appPreference()).toBeUndefined()
  })

  it('forgets a preference when the app leaves the alternate screen', () => {
    const { terminal, handlers } = fakeTerminal()
    const tracked = attachTerminalAlternateScrollModeTracking(terminal)

    handlers.csi.get('?h')?.([1049])
    handlers.csi.get('?h')?.([1007])
    expect(tracked.appPreference()).toBe(true)

    handlers.csi.get('?l')?.([1049])
    expect(tracked.appPreference()).toBeUndefined()
  })

  it('forgets a disabled preference so the next app is not retuned by it', () => {
    const { terminal, handlers } = fakeTerminal()
    const tracked = attachTerminalAlternateScrollModeTracking(terminal)

    handlers.csi.get('?l')?.([1007])
    expect(tracked.appPreference()).toBe(false)

    handlers.csi.get('?l')?.([1049])
    expect(tracked.appPreference()).toBeUndefined()

    handlers.csi.get('?h')?.([1049])
    expect(tracked.appPreference()).toBeUndefined()
  })

  it('starts a fresh alternate-screen session even when entry reuses the sequence', () => {
    const { terminal, handlers } = fakeTerminal()
    const tracked = attachTerminalAlternateScrollModeTracking(terminal)

    handlers.csi.get('?l')?.([1007])
    handlers.csi.get('?h')?.([1049, 1007])
    expect(tracked.appPreference()).toBe(true)
  })

  it('covers the older alternate-screen modes', () => {
    for (const mode of [1049, 1047, 47]) {
      const { terminal, handlers } = fakeTerminal()
      const tracked = attachTerminalAlternateScrollModeTracking(terminal)
      handlers.csi.get('?h')?.([1007])
      handlers.csi.get('?l')?.([mode])
      expect(tracked.appPreference()).toBeUndefined()
    }
  })

  it('removes every registration on dispose', () => {
    const { terminal, handlers } = fakeTerminal()
    attachTerminalAlternateScrollModeTracking(terminal).dispose()
    expect(handlers.disposed.sort()).toEqual(['!p', '?h', '?l', 'esc:c'])
  })

  it('degrades to no preference on a parser without handler registration', () => {
    const tracked = attachTerminalAlternateScrollModeTracking({})
    expect(tracked.appPreference()).toBeUndefined()
    expect(() => tracked.dispose()).not.toThrow()
  })
})
