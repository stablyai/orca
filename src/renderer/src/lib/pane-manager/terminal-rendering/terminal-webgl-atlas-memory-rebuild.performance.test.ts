import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from '../pane-manager-types'
import type * as AtlasMemoryRebuild from './terminal-webgl-atlas-memory-rebuild'

// Guards #43465: atlas-memory rebuilds need PTY output into the grown atlas, wait for it to pause and for typing to stop, stay ≥60 s apart and only touch that atlas's panes.
const QUIET = 2_000
const INTERVAL = 60_000
const MAC_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron'
const LARGE_PAGE = { width: 4096 }

const rebuilds: ManagedPaneInternal[][] = []
const reattached: ManagedPaneInternal[][] = []
const visibleContainers = new Set<unknown>()
const visibilityScans = { count: 0 }
vi.mock('../pane-manager-registry', () => ({
  isElementInVisiblePaneManager: (element: unknown) => {
    visibilityScans.count++
    return visibleContainers.has(element)
  }
}))

type AtlasModule = typeof AtlasMemoryRebuild

type FakeAtlas = { readonly pages: unknown[] }
const newAtlas = (): FakeAtlas => ({ pages: [] })

function fakePane(
  atlasModule: AtlasModule,
  atlas: FakeAtlas,
  visible = true,
  displayed = true,
  covered = false
) {
  const terminal = { modes: { synchronizedOutputMode: false } }
  const container = {
    getClientRects: () => (displayed ? [{}] : []),
    querySelector: () => (covered ? {} : null)
  }
  if (visible) {
    visibleContainers.add(container)
  }
  const renderer = { _charAtlas: atlas }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the module reads only terminal modes, container rects, chat cover and the addon's atlas identity, all supplied here.
  const pane = {
    terminal,
    container,
    webglAddon: { _renderer: renderer }
  } as unknown as ManagedPaneInternal
  atlasModule.trackTerminalWebglAtlasPane(pane)
  return {
    pane,
    terminal,
    renderer,
    output: () => atlasModule.noteTerminalWebglAtlasOutput(pane.terminal)
  }
}

async function loadModule(navigatorStub: { userAgent: string; maxTouchPoints?: number }) {
  vi.resetModules()
  vi.stubGlobal('navigator', navigatorStub)
  const atlas = await import('./terminal-webgl-atlas-memory-rebuild')
  atlas.setTerminalWebglAtlasRebuilder((panes, shouldReattach) => {
    rebuilds.push(panes)
    reattached.push(panes.filter(shouldReattach))
  })
  return atlas
}

describe('terminal WebGL atlas-memory rebuild', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    rebuilds.length = 0
    reattached.length = 0
    visibleContainers.clear()
    visibilityScans.count = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('never rebuilds an atlas that grew without PTY output into it', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const { pane } = fakePane(atlas, newAtlas())
    for (let i = 0; i < 20; i++) {
      atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, pane)
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(rebuilds).toHaveLength(0)
  })

  it('counts output that arrives before or after the large page', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const first = fakePane(atlas, newAtlas())
    first.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, first.pane)
    await vi.advanceTimersByTimeAsync(QUIET)
    const second = fakePane(atlas, newAtlas())
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, second.pane)
    second.output()
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(rebuilds).toEqual([[first.pane], [second.pane]])
  })

  it('waits for output into the atlas to pause', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const busy = fakePane(atlas, newAtlas())
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, busy.pane)
    for (let i = 0; i < 20; i++) {
      busy.output()
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(rebuilds).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(QUIET)
    expect(rebuilds).toEqual([[busy.pane]])
  })

  it('holds the rebuild while the user types, even once overdue', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const busy = fakePane(atlas, newAtlas())
    busy.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, busy.pane)
    for (let i = 0; i < 180; i++) {
      atlas.noteTerminalWebglAtlasTyping()
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(rebuilds).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(QUIET)
    expect(rebuilds).toEqual([[busy.pane]])
  })

  it('rebuilds output that never pauses once overdue, at most once per 60 s', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    let current = fakePane(atlas, newAtlas())
    for (let i = 0; i < 290; i++) {
      if (rebuilds.at(-1)?.[0] === current.pane) {
        // A rebuild retires the atlas; the reattached renderer gets a fresh one.
        atlas.untrackTerminalWebglAtlasPane(current.pane)
        current = fakePane(atlas, newAtlas())
      }
      current.output()
      atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, current.pane)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    // t = 60, 120, 180, 240 s.
    expect(rebuilds).toHaveLength(4)
    // One pending timer at most, however many chunks arrived.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
  })

  it('rebuilds only the panes that share the grown atlas, re-armed only by their own output', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const grown = newAtlas()
    const a = fakePane(atlas, grown)
    const b = fakePane(atlas, grown, false)
    const other = fakePane(atlas, newAtlas())
    a.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, a.pane)
    await vi.advanceTimersByTimeAsync(QUIET)
    expect(rebuilds).toEqual([[a.pane, b.pane]])
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, a.pane)
    for (let i = 0; i < 6; i++) {
      other.output()
      await vi.advanceTimersByTimeAsync(INTERVAL)
    }
    expect(rebuilds).toHaveLength(1)
  })

  it('rebuilds a quiet pane that switched onto the grown atlas', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const grown = newAtlas()
    const busy = fakePane(atlas, grown)
    const quiet = fakePane(atlas, newAtlas())
    // A font zoom moves the quiet pane onto the grown atlas after its large page, with no output.
    atlas.noteTerminalWebglAtlasChange(quiet.pane)
    // xterm assigns the new atlas after firing the change event.
    quiet.renderer._charAtlas = grown
    busy.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, busy.pane)
    await vi.advanceTimersByTimeAsync(QUIET)
    expect(rebuilds).toEqual([[busy.pane, quiet.pane]])
  })

  it('never starts while an on-screen pane is mid synchronized-output frame, and catches the gap between frames once overdue', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const visible = fakePane(atlas, newAtlas())
    visible.terminal.modes.synchronizedOutputMode = true
    visible.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, visible.pane)
    await vi.advanceTimersByTimeAsync(QUIET + 3 * INTERVAL)
    expect(rebuilds).toHaveLength(0)
    // A TUI that keeps reopening frames: the overdue atlas checks every 250 ms and rebuilds in the next gap.
    visible.terminal.modes.synchronizedOutputMode = false
    await vi.advanceTimersByTimeAsync(250)
    expect(rebuilds).toEqual([[visible.pane]])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('catches a frame that closes without further output', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const visible = fakePane(atlas, newAtlas())
    visible.terminal.modes.synchronizedOutputMode = true
    visible.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, visible.pane)
    await vi.advanceTimersByTimeAsync(QUIET)
    visible.terminal.modes.synchronizedOutputMode = false
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(rebuilds).toEqual([[visible.pane]])
  })

  it('keeps attempts bounded however many chunks arrive inside frames', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const visible = fakePane(atlas, newAtlas())
    visible.terminal.modes.synchronizedOutputMode = true
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, visible.pane)
    for (let i = 0; i < 1_200; i++) {
      visible.output()
      await vi.advanceTimersByTimeAsync(100)
    }
    // 120 s of chunks inside one open frame: one attempt at 60 s, then one look per 250 ms while overdue.
    expect(rebuilds).toHaveLength(0)
    expect(visibilityScans.count).toBeLessThanOrEqual(1 + 60_000 / 250 + 1)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
  })

  it('visits only the due atlas owners on each attempt, however many terminals are attached', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const atlasReads = { count: 0 }
    for (let i = 0; i < 300; i++) {
      const { pane } = fakePane(atlas, newAtlas())
      const addon = pane.webglAddon
      Object.defineProperty(pane, 'webglAddon', {
        get: () => {
          atlasReads.count++
          return addon
        }
      })
    }
    const visible = fakePane(atlas, newAtlas())
    visible.terminal.modes.synchronizedOutputMode = true
    visible.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, visible.pane)
    await vi.advanceTimersByTimeAsync(QUIET + 3 * INTERVAL)
    expect(rebuilds).toHaveLength(0)
    expect(atlasReads.count).toBe(0)
  })

  it('ignores a hidden pane mid synchronized-output frame', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const hidden = fakePane(atlas, newAtlas(), false)
    hidden.terminal.modes.synchronizedOutputMode = true
    hidden.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, hidden.pane)
    await vi.advanceTimersByTimeAsync(QUIET)
    expect(rebuilds).toEqual([[hidden.pane]])
  })

  it('reattaches only panes on screen', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const grown = newAtlas()
    const shown = fakePane(atlas, grown)
    const hiddenTab = fakePane(atlas, grown, false)
    const expandedSibling = fakePane(atlas, grown, true, false)
    expandedSibling.terminal.modes.synchronizedOutputMode = true
    shown.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, shown.pane)
    await vi.advanceTimersByTimeAsync(QUIET)
    expect(rebuilds).toEqual([[shown.pane, hiddenTab.pane, expandedSibling.pane]])
    expect(reattached).toEqual([[shown.pane]])
  })

  it('leaves a chat-covered pane detached until its cover closes', async () => {
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const grown = newAtlas()
    const shown = fakePane(atlas, grown)
    const covered = fakePane(atlas, grown, true, true, true)
    covered.terminal.modes.synchronizedOutputMode = true
    shown.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, shown.pane)
    await vi.advanceTimersByTimeAsync(QUIET)
    expect(rebuilds).toEqual([[shown.pane, covered.pane]])
    expect(reattached).toEqual([[shown.pane]])
    expect(atlas.takeCoveredDetachedPane(covered.pane.terminal)).toBe(covered.pane)
    expect(atlas.takeCoveredDetachedPane(covered.pane.terminal)).toBeUndefined()
  })

  it('reattaches nothing while the window is hidden', async () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    const atlas = await loadModule({ userAgent: MAC_AGENT })
    const shown = fakePane(atlas, newAtlas())
    shown.terminal.modes.synchronizedOutputMode = true
    shown.output()
    atlas.handleTerminalWebglAtlasPage(LARGE_PAGE, shown.pane)
    await vi.advanceTimersByTimeAsync(QUIET)
    expect(rebuilds).toEqual([[shown.pane]])
    expect(reattached).toEqual([[]])
  })

  it('ignores other page sizes, touch Apple devices and other platforms', async () => {
    const mac = await loadModule({ userAgent: MAC_AGENT })
    const macPane = fakePane(mac, newAtlas())
    macPane.output()
    mac.handleTerminalWebglAtlasPage({ width: 2048 }, macPane.pane)
    mac.handleTerminalWebglAtlasPage({ width: 16384 }, macPane.pane)
    const ipad = await loadModule({ userAgent: MAC_AGENT, maxTouchPoints: 5 })
    const ipadPane = fakePane(ipad, newAtlas())
    ipadPane.output()
    ipad.handleTerminalWebglAtlasPage(LARGE_PAGE, ipadPane.pane)
    const windows = await loadModule({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    const windowsPane = fakePane(windows, newAtlas())
    windowsPane.output()
    windows.handleTerminalWebglAtlasPage(LARGE_PAGE, windowsPane.pane)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rebuilds).toHaveLength(0)
  })
})
