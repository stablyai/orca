import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from '../pane-manager-types'

// Guards #43465: an atlas rebuild recreates at most one WebGL context per frame, so many panes can't stall one task.
const attaches = { count: 0 }
let rebuilder: ((panes: ManagedPaneInternal[], shouldReattach: () => boolean) => void) | null = null

vi.mock('./pane-webgl-renderer', () => ({
  attachWebgl: (pane: { webglAddon: unknown }) => {
    attaches.count++
    pane.webglAddon = {}
  },
  disposeWebgl: (pane: { webglAddon: unknown }) => {
    pane.webglAddon = null
  },
  clearTerminalWebglAttachBackoff: () => {}
}))
vi.mock('./terminal-webgl-atlas-memory-rebuild', () => ({
  setTerminalWebglAtlasRebuilder: (next: typeof rebuilder) => {
    rebuilder = next
  },
  takeCoveredDetachedPane: () => undefined
}))
vi.mock('./terminal-render-pause-release', () => ({ paintReplacementCanvasNow: () => {} }))

type RawPane = { webglAddon: object | null; container: { isConnected: boolean } }

function fakePane(): { pane: ManagedPaneInternal; raw: RawPane } {
  const raw = {
    webglAddon: {},
    webglDisabledAfterContextLoss: false,
    webglAttachmentDeferred: false,
    container: { isConnected: true },
    terminal: {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rebuilder reads only the addon, deferral and context-loss flags, the container's connection and the terminal handle, all supplied here.
  const pane = raw as unknown as ManagedPaneInternal
  return { pane, raw }
}

describe('atlas-rebuild reattachment', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16))
    attaches.count = 0
    vi.resetModules()
    await import('./pane-webgl-reattach')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('recreates one context per frame', async () => {
    const fakes = Array.from({ length: 6 }, fakePane)
    rebuilder?.(
      fakes.map((fake) => fake.pane),
      () => true
    )
    expect(attaches.count).toBe(1)
    await vi.advanceTimersByTimeAsync(16)
    expect(attaches.count).toBe(2)
    await vi.advanceTimersByTimeAsync(16 * 4)
    expect(attaches.count).toBe(6)
    expect(fakes.every((fake) => fake.raw.webglAddon)).toBe(true)
  })

  it('skips a pane that closed or got its renderer back before its frame', async () => {
    const [first, closed, revealed] = Array.from({ length: 3 }, fakePane)
    rebuilder?.([first.pane, closed.pane, revealed.pane], () => true)
    closed.raw.container.isConnected = false
    revealed.raw.webglAddon = {}
    await vi.advanceTimersByTimeAsync(16 * 3)
    expect(attaches.count).toBe(1)
  })
})
