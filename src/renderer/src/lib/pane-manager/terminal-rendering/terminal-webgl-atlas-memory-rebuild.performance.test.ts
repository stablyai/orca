import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from '../pane-manager-types'
import type * as AtlasMemoryRebuild from './terminal-webgl-atlas-memory-rebuild'

// Guards #43465: atlas-memory rebuilds need PTY output into the grown atlas, stay ≥10 s apart and only touch that atlas's panes.
const MAC_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron'
const LARGE_PAGE = { width: 4096 }

const rebuilds: ManagedPaneInternal[][] = []
const visibleTerminals = new Set<unknown>()
vi.mock('../pane-manager-registry', () => ({
  getVisiblePaneTerminals: () => visibleTerminals,
  rebuildTerminalWebglRenderersForPanes: (panes: ReadonlySet<ManagedPaneInternal>) => {
    rebuilds.push([...panes])
  }
}))

type AtlasModule = typeof AtlasMemoryRebuild

function fakePane(atlasModule: AtlasModule, atlas: object, visible = true) {
  const terminal = { modes: { synchronizedOutputMode: false } }
  if (visible) {
    visibleTerminals.add(terminal)
  }
  const pane = {
    terminal,
    webglAddon: { _renderer: { _charAtlas: atlas } }
  } as unknown as ManagedPaneInternal
  atlasModule.trackTerminalWebglAtlasPane(pane)
  return { pane, terminal, output: () => atlasModule.noteTerminalWebglAtlasOutput(terminal) }
}

async function loadModule(navigatorStub: { userAgent: string; maxTouchPoints?: number }) {
  vi.resetModules()
  vi.stubGlobal('navigator', navigatorStub)
  return import('./terminal-webgl-atlas-memory-rebuild')
}

describe('terminal WebGL atlas-memory rebuild', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    rebuilds.length = 0
    visibleTerminals.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('never rebuilds an atlas that grew without PTY output into it', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const { pane } = fakePane(atlas, {})
    for (let i = 0; i < 20; i++) {
      atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, pane)
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(rebuilds).toHaveLength(0)
  })

  it('counts output that arrives before or after the large page', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const first = fakePane(atlas, {})
    first.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, first.pane)
    await vi.advanceTimersByTimeAsync(0)
    const second = fakePane(atlas, {})
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, second.pane)
    second.output()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(rebuilds).toEqual([[first.pane], [second.pane]])
  })

  it('rebuilds at most once per 10 s under sustained output', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    let current = fakePane(atlas, {})
    for (let i = 0; i < 60; i++) {
      if (rebuilds.at(-1)?.[0] === current.pane) {
        // A rebuild retires the atlas; the reattached renderer gets a fresh one.
        atlas.untrackTerminalWebglAtlasPane(current.pane)
        current = fakePane(atlas, {})
      }
      current.output()
      atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, current.pane)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    // t = 0, 10, …, 60 s.
    expect(rebuilds).toHaveLength(7)
  })

  it('rebuilds only the panes that share the grown atlas, re-armed only by their own output', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const grown = {}
    const a = fakePane(atlas, grown)
    const b = fakePane(atlas, grown, false)
    const other = fakePane(atlas, {})
    a.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, a.pane)
    await vi.advanceTimersByTimeAsync(0)
    expect(rebuilds).toEqual([[a.pane, b.pane]])
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, a.pane)
    for (let i = 0; i < 6; i++) {
      other.output()
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(rebuilds).toHaveLength(1)
  })

  it('waits for a visible synchronized-output frame without polling, ignoring hidden ones', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const visible = fakePane(atlas, {})
    visible.terminal.modes.synchronizedOutputMode = true
    visible.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, visible.pane)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rebuilds).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    visible.terminal.modes.synchronizedOutputMode = false
    visible.output()
    await vi.advanceTimersByTimeAsync(0)
    expect(rebuilds).toEqual([[visible.pane]])

    const hidden = fakePane(atlas, {}, false)
    hidden.terminal.modes.synchronizedOutputMode = true
    hidden.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, hidden.pane)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(rebuilds).toHaveLength(2)
  })

  it('ignores other page sizes, touch Apple devices and other platforms', async () => {
    const mac = await loadModule({ userAgent: MAC_AGENT })
    const macPane = fakePane(mac, {})
    macPane.output()
    mac.handleTerminalWebglAtlasPage({ width: 2048 }, macPane.pane)
    mac.handleTerminalWebglAtlasPage({ width: 16384 }, macPane.pane)
    const ipad = await loadModule({ userAgent: MAC_AGENT, maxTouchPoints: 5 })
    const ipadPane = fakePane(ipad, {})
    ipadPane.output()
    ipad.handleTerminalWebglAtlasPage(LARGE_PAGE, ipadPane.pane)
    const windows = await loadModule({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    const windowsPane = fakePane(windows, {})
    windowsPane.output()
    windows.handleTerminalWebglAtlasPage(LARGE_PAGE, windowsPane.pane)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rebuilds).toHaveLength(0)
  })
})
