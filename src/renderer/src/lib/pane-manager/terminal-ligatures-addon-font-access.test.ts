import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { TerminalLigaturesAddon } from './terminal-ligatures-addon'

describe('TerminalLigaturesAddon font access', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('joins common ligatures without reading installed font files', async () => {
    const queryLocalFonts = vi.fn(async () => [])
    vi.stubGlobal('window', { queryLocalFonts })
    let joiner: ((text: string) => [number, number][]) | null = null
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture provides every Terminal member the addon touches.
    const terminal = {
      element: { style: {} },
      options: { fontFamily: '"Commit Mono", monospace' },
      rows: 24,
      refresh: vi.fn(),
      registerCharacterJoiner(registered: (text: string) => [number, number][]): number {
        joiner = registered
        return 1
      },
      deregisterCharacterJoiner: vi.fn()
    } as unknown as Terminal
    new TerminalLigaturesAddon().activate(terminal)

    const ranges = joiner!('a => b')
    await Promise.resolve()

    expect(ranges).toEqual([[2, 4]])
    expect(queryLocalFonts).not.toHaveBeenCalled()
  })
})
