import { afterEach, describe, expect, it, vi } from 'vitest'

const resetAndRefreshAllTerminalWebglAtlases = vi.fn()
vi.mock('./pane-manager-registry', () => ({ resetAndRefreshAllTerminalWebglAtlases }))

function loadingDone(fonts: EventTarget, family: string): void {
  fonts.dispatchEvent(Object.assign(new Event('loadingdone'), { fontfaces: [{ family }] }))
}

describe('watchTerminalSymbolsFontLoad', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
    resetAndRefreshAllTerminalWebglAtlases.mockClear()
  })

  it('resets atlases once, only when the bundled symbols face finishes loading', async () => {
    const fonts = new EventTarget()
    vi.stubGlobal('document', { fonts })
    const { watchTerminalSymbolsFontLoad } = await import('./terminal-symbols-font')

    watchTerminalSymbolsFontLoad()
    watchTerminalSymbolsFontLoad()
    loadingDone(fonts, 'JetBrains Mono')
    expect(resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()

    loadingDone(fonts, '"Orca Nerd Font Symbols"')
    loadingDone(fonts, 'Orca Nerd Font Symbols')
    expect(resetAndRefreshAllTerminalWebglAtlases).toHaveBeenCalledTimes(1)
    expect(resetAndRefreshAllTerminalWebglAtlases).toHaveBeenCalledWith('symbols-font-loaded', {
      includeHidden: true
    })
  })
})
