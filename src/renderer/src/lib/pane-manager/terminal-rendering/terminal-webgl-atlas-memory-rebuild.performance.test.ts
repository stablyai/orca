import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Guards #43465: atlas-memory rebuilds of every WebGL renderer need output since the last one and stay ≥10 s apart.
const rebuildAll = vi.fn()
vi.mock('../pane-manager-registry', () => ({ rebuildAllTerminalWebglRenderers: rebuildAll }))

const MAC_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron'
const LARGE_PAGE = { width: 4096 }

function fakeTerminal() {
  const listeners = new Set<() => void>()
  return {
    onWriteParsed(listener: () => void) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    write() {
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

async function loadModule(navigatorStub: { userAgent: string; maxTouchPoints?: number }) {
  vi.resetModules()
  vi.stubGlobal('navigator', navigatorStub)
  return import('./terminal-webgl-atlas-memory-rebuild')
}

describe('terminal WebGL atlas-memory rebuild', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    rebuildAll.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('never rebuilds again from large pages that arrive without new output', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    atlas.watchTerminalWebglAtlasOutput(fakeTerminal())
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE)
    await vi.advanceTimersByTimeAsync(0)
    expect(rebuildAll).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) {
      atlas.handleTerminalWebglAtlasPage(LARGE_PAGE)
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(rebuildAll).toHaveBeenCalledTimes(1)
  })

  it('counts output parsed before the large page arrives', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const terminal = fakeTerminal()
    atlas.watchTerminalWebglAtlasOutput(terminal)
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE)
    await vi.advanceTimersByTimeAsync(0)
    terminal.write()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(rebuildAll).toHaveBeenCalledTimes(2)
  })

  it('rebuilds at most once per 10 s under sustained output', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const terminal = fakeTerminal()
    atlas.watchTerminalWebglAtlasOutput(terminal)
    for (let i = 0; i < 60; i++) {
      terminal.write()
      atlas.handleTerminalWebglAtlasPage(LARGE_PAGE)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    // t = 0, 10, …, 60 s.
    expect(rebuildAll).toHaveBeenCalledTimes(7)
  })

  it('ignores other page sizes, touch Apple devices and other platforms', async () => {
    const mac = await loadModule({ userAgent: MAC_AGENT })
    mac.handleTerminalWebglAtlasPage({ width: 2048 })
    mac.handleTerminalWebglAtlasPage({ width: 16384 })
    const ipad = await loadModule({ userAgent: MAC_AGENT, maxTouchPoints: 5 })
    ipad.handleTerminalWebglAtlasPage(LARGE_PAGE)
    const windows = await loadModule({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    windows.handleTerminalWebglAtlasPage(LARGE_PAGE)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rebuildAll).not.toHaveBeenCalled()
  })
})
