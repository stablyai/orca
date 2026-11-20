import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from '../pane-manager-types'

// Guards #43465: atlas-memory rebuilds need output since the last one, stay ≥10 s apart and only touch the grown atlas's panes.
const MAC_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron'
const LARGE_PAGE = { width: 4096 }

function fakePane(atlas: object) {
  const listeners = new Set<() => void>()
  const terminal = {
    modes: { synchronizedOutputMode: false },
    onCursorMove(listener: () => void) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    }
  }
  const pane = {
    terminal,
    webglAddon: { _renderer: { _charAtlas: atlas } }
  } as unknown as ManagedPaneInternal
  const print = () => {
    for (const listener of listeners) {
      listener()
    }
  }
  return { pane, terminal, print }
}

async function loadModule(navigatorStub: { userAgent: string; maxTouchPoints?: number }) {
  vi.resetModules()
  vi.stubGlobal('navigator', navigatorStub)
  const atlas = await import('./terminal-webgl-atlas-memory-rebuild')
  const rebuilds: ManagedPaneInternal[][] = []
  atlas.setTerminalWebglAtlasRebuilder((panes) => rebuilds.push(panes))
  return { ...atlas, rebuilds }
}

describe('terminal WebGL atlas-memory rebuild', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('never rebuilds again from large pages that arrive without new output', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const { pane } = fakePane({})
    atlas.watchTerminalWebglAtlasOutput(pane)
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, pane)
    await vi.advanceTimersByTimeAsync(0)
    expect(atlas.rebuilds).toHaveLength(1)
    for (let i = 0; i < 20; i++) {
      atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, pane)
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(atlas.rebuilds).toHaveLength(1)
  })

  it('counts output printed before the large page arrives', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const { pane, print } = fakePane({})
    atlas.watchTerminalWebglAtlasOutput(pane)
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, pane)
    await vi.advanceTimersByTimeAsync(0)
    print()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, pane)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(atlas.rebuilds).toHaveLength(2)
  })

  it('rebuilds at most once per 10 s under sustained output', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const { pane, print } = fakePane({})
    atlas.watchTerminalWebglAtlasOutput(pane)
    for (let i = 0; i < 60; i++) {
      print()
      atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, pane)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    // t = 0, 10, …, 60 s.
    expect(atlas.rebuilds).toHaveLength(7)
  })

  it('rebuilds only the panes that share the grown atlas', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const grown = {}
    const a = fakePane(grown)
    const b = fakePane(grown)
    const other = fakePane({})
    for (const { pane } of [a, b, other]) {
      atlas.watchTerminalWebglAtlasOutput(pane)
    }
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, a.pane)
    await vi.advanceTimersByTimeAsync(0)
    expect(atlas.rebuilds).toEqual([[a.pane, b.pane]])
  })

  it('waits for a synchronized-output frame to finish', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const { pane, terminal } = fakePane({})
    atlas.watchTerminalWebglAtlasOutput(pane)
    terminal.modes.synchronizedOutputMode = true
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, pane)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(atlas.rebuilds).toHaveLength(0)
    terminal.modes.synchronizedOutputMode = false
    await vi.advanceTimersByTimeAsync(250)
    expect(atlas.rebuilds).toHaveLength(1)
  })

  it('ignores other page sizes, touch Apple devices and other platforms', async () => {
    const mac = await loadModule({ userAgent: MAC_AGENT })
    const macPane = fakePane({}).pane
    mac.watchTerminalWebglAtlasOutput(macPane)
    mac.handleTerminalWebglAtlasPage({ width: 2048 }, macPane)
    mac.handleTerminalWebglAtlasPage({ width: 16384 }, macPane)
    const ipad = await loadModule({ userAgent: MAC_AGENT, maxTouchPoints: 5 })
    const ipadPane = fakePane({}).pane
    ipad.watchTerminalWebglAtlasOutput(ipadPane)
    ipad.handleTerminalWebglAtlasPage(LARGE_PAGE, ipadPane)
    const windows = await loadModule({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    const windowsPane = fakePane({}).pane
    windows.watchTerminalWebglAtlasOutput(windowsPane)
    windows.handleTerminalWebglAtlasPage(LARGE_PAGE, windowsPane)
    await vi.advanceTimersByTimeAsync(60_000)
    expect([...mac.rebuilds, ...ipad.rebuilds, ...windows.rebuilds]).toHaveLength(0)
  })
})
