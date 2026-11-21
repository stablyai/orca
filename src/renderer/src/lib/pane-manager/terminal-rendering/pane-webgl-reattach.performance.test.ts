import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from '../pane-manager-types'

// Guards #43465: an atlas rebuild recreates at most one WebGL context per frame, so many panes can't stall one task.
const attaches = { count: 0 }
type Verdict = 'now' | 'wait' | 'skip'
let rebuilder:
  | ((
      panes: ManagedPaneInternal[],
      shouldReattach: () => boolean,
      verdict: (pane: ManagedPaneInternal) => Verdict
    ) => void)
  | null = null

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
const typingHold = { ms: 0 }
vi.mock('./terminal-webgl-atlas-memory-rebuild', () => ({
  setTerminalWebglAtlasRebuilder: (next: typeof rebuilder) => {
    rebuilder = next
  },
  takeCoveredDetachedPane: () => undefined,
  terminalWebglAtlasTypingHoldMs: () => typingHold.ms
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
    typingHold.ms = 0
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
      () => true,
      () => 'now'
    )
    expect(attaches.count).toBe(1)
    await vi.advanceTimersByTimeAsync(16)
    expect(attaches.count).toBe(2)
    await vi.advanceTimersByTimeAsync(16 * 4)
    expect(attaches.count).toBe(6)
    expect(fakes.every((fake) => fake.raw.webglAddon)).toBe(true)
  })

  it('creates no context while the user types mid-chain, then resumes', async () => {
    const fakes = Array.from({ length: 3 }, fakePane)
    rebuilder?.(
      fakes.map((fake) => fake.pane),
      () => true,
      () => 'now'
    )
    expect(attaches.count).toBe(1)
    typingHold.ms = 2_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(attaches.count).toBe(1)
    typingHold.ms = 0
    // The hold ends 2 s after the frame that saw it (t = 16 ms), then waits one more frame.
    await vi.advanceTimersByTimeAsync(1_040)
    expect(attaches.count).toBe(2)
    await vi.advanceTimersByTimeAsync(16)
    expect(attaches.count).toBe(3)
  })

  it('skips a pane that closed or got its renderer back before its frame', async () => {
    const [first, closed, revealed] = Array.from({ length: 3 }, fakePane)
    rebuilder?.(
      [first.pane, closed.pane, revealed.pane],
      () => true,
      () => 'now'
    )
    closed.raw.container.isConnected = false
    revealed.raw.webglAddon = {}
    await vi.advanceTimersByTimeAsync(16 * 3)
    expect(attaches.count).toBe(1)
  })

  it('rechecks each waiting pane on its frame: hidden ones stay detached, mid-frame ones wait', async () => {
    const [first, hidden, drawing] = Array.from({ length: 3 }, fakePane)
    const verdicts = new Map<ManagedPaneInternal, Verdict>([
      [hidden.pane, 'skip'],
      [drawing.pane, 'wait']
    ])
    rebuilder?.(
      [first.pane, hidden.pane, drawing.pane],
      () => true,
      (pane) => verdicts.get(pane) ?? 'now'
    )
    await vi.advanceTimersByTimeAsync(16 * 5)
    expect(attaches.count).toBe(1)
    expect(hidden.raw.webglAddon).toBeNull()
    verdicts.set(drawing.pane, 'now')
    await vi.advanceTimersByTimeAsync(16)
    expect(attaches.count).toBe(2)
  })
})
