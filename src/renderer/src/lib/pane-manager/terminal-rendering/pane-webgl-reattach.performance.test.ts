import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from '../pane-manager-types'

// Guards #43465: an atlas rebuild recreates at most one WebGL context per frame, decides each pane on its own frame, never leaves a shown pane on the DOM renderer or paints mid-frame, and pauses while the user interacts.
const attaches = { count: 0 }
const interactionHold = { ms: 0 }
const parked: { value: boolean; resume: (() => void) | null } = { value: false, resume: null }
type Verdict = 'now' | 'wait' | 'skip'
let rebuilder:
  | ((
      panes: ManagedPaneInternal[],
      shouldReattach: (pane: ManagedPaneInternal) => boolean,
      verdict: (pane: ManagedPaneInternal) => Verdict
    ) => void)
  | null = null

type FakeAddon = { clears: number; clearTextureAtlas: () => void }
const newAddon = (): FakeAddon => {
  const addon = {
    clears: 0,
    clearTextureAtlas: () => {
      addon.clears++
    }
  }
  return addon
}

vi.mock('./pane-webgl-renderer', () => ({
  attachWebgl: (pane: { webglAddon: unknown }) => {
    attaches.count++
    pane.webglAddon = newAddon()
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
vi.mock('./terminal-webgl-atlas-rebuild-interaction', () => ({
  terminalWebglAtlasInteractionHoldMs: () => interactionHold.ms,
  isTerminalWebglAtlasRebuildParked: () => parked.value,
  whenTerminalWebglAtlasRebuildUnparked: (resume: () => void) => {
    parked.resume = resume
  }
}))
vi.mock('./terminal-render-pause-release', () => ({ paintReplacementCanvasNow: () => {} }))

type RawPane = {
  webglAddon: FakeAddon | null
  container: { isConnected: boolean }
  terminal: { modes: { synchronizedOutputMode: boolean } }
}

function fakePane(): { pane: ManagedPaneInternal; raw: RawPane } {
  const raw = {
    webglAddon: newAddon(),
    webglDisabledAfterContextLoss: false,
    webglAttachmentDeferred: false,
    container: { isConnected: true },
    terminal: { modes: { synchronizedOutputMode: false } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rebuilder reads only the addon, deferral and context-loss flags, the container's connection and the terminal's modes, all supplied here.
  const pane = raw as unknown as ManagedPaneInternal
  return { pane, raw }
}

const run = (
  fakes: { pane: ManagedPaneInternal }[],
  verdict: (pane: ManagedPaneInternal) => Verdict = () => 'now',
  shown: (pane: ManagedPaneInternal) => boolean = () => true
): void =>
  rebuilder?.(
    fakes.map((fake) => fake.pane),
    shown,
    verdict
  )

describe('atlas-rebuild context recreation', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16))
    attaches.count = 0
    interactionHold.ms = 0
    parked.value = false
    parked.resume = null
    vi.resetModules()
    await import('./pane-webgl-reattach')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('recreates one context per frame, starting on a frame of its own, without ever dropping a shown pane to DOM', async () => {
    const fakes = Array.from({ length: 6 }, fakePane)
    run(fakes)
    expect(attaches.count).toBe(0)
    for (let frame = 1; frame <= 6; frame++) {
      expect(fakes.every((fake) => fake.raw.webglAddon)).toBe(true)
      await vi.advanceTimersByTimeAsync(16)
      expect(attaches.count).toBe(frame)
    }
  })

  it('creates no context while the user types, clicks or scrolls, then resumes', async () => {
    const fakes = Array.from({ length: 3 }, fakePane)
    run(fakes)
    await vi.advanceTimersByTimeAsync(16)
    expect(attaches.count).toBe(1)
    interactionHold.ms = 2_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(attaches.count).toBe(1)
    // Held panes keep their old context meanwhile.
    expect(fakes.every((fake) => fake.raw.webglAddon)).toBe(true)
    interactionHold.ms = 0
    // The hold ends 2 s after the frame that saw it (t = 32 ms), then waits one more frame.
    await vi.advanceTimersByTimeAsync(1_040)
    expect(attaches.count).toBe(2)
    await vi.advanceTimersByTimeAsync(16)
    expect(attaches.count).toBe(3)
  })

  it('decides each pane on its own frame: hidden ones drop their context, one revealed meanwhile gets a new one', async () => {
    const [shown, hidden, revealed] = Array.from({ length: 3 }, fakePane)
    const onScreen = new Set([shown.pane])
    run(
      [shown, hidden, revealed],
      (pane) => (onScreen.has(pane) ? 'now' : 'skip'),
      (pane) => onScreen.has(pane)
    )
    await vi.advanceTimersByTimeAsync(16)
    expect(attaches.count).toBe(1)
    onScreen.add(revealed.pane)
    await vi.advanceTimersByTimeAsync(16 * 2)
    expect(hidden.raw.webglAddon).toBeNull()
    expect(revealed.raw.webglAddon).toBeTruthy()
    expect(attaches.count).toBe(2)
  })

  it('lets panes behind one mid synchronized-output frame go first, and recreates it once its frame closes', async () => {
    const [framed, plain] = Array.from({ length: 2 }, fakePane)
    framed.raw.terminal.modes.synchronizedOutputMode = true
    run([framed, plain], (pane) => (pane.terminal.modes.synchronizedOutputMode ? 'wait' : 'now'))
    await vi.advanceTimersByTimeAsync(16)
    // The waiting pane went to the back; the plain one was recreated in its place.
    expect(attaches.count).toBe(1)
    expect(plain.raw.webglAddon).toBeTruthy()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(attaches.count).toBe(1)
    // It keeps its old context while it waits.
    expect(framed.raw.webglAddon).toBeTruthy()
    framed.raw.terminal.modes.synchronizedOutputMode = false
    await vi.advanceTimersByTimeAsync(300)
    expect(attaches.count).toBe(2)
  })

  it('never paints a pane mid-frame: after 10 s of an open frame it keeps its old context and the queue ends', async () => {
    const [framed] = Array.from({ length: 1 }, fakePane)
    framed.raw.terminal.modes.synchronizedOutputMode = true
    run([framed], () => 'wait')
    await vi.advanceTimersByTimeAsync(11_000)
    expect(attaches.count).toBe(0)
    expect(framed.raw.webglAddon).toBeTruthy()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('touches no context while the window is hidden or unfocused, and resumes when it is back', async () => {
    const fakes = Array.from({ length: 3 }, fakePane)
    run(fakes)
    await vi.advanceTimersByTimeAsync(16)
    expect(attaches.count).toBe(1)
    parked.value = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(attaches.count).toBe(1)
    expect(fakes.every((fake) => fake.raw.webglAddon)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    parked.value = false
    parked.resume?.()
    await vi.advanceTimersByTimeAsync(16 * 2)
    expect(attaches.count).toBe(3)
  })

  it('runs overlapping rebuilds through one queue: still one context per frame', async () => {
    const first = Array.from({ length: 3 }, fakePane)
    const second = Array.from({ length: 3 }, fakePane)
    run(first)
    run(second)
    for (let frame = 1; frame <= 6; frame++) {
      await vi.advanceTimersByTimeAsync(16)
      expect(attaches.count).toBe(frame)
    }
  })

  it.each([300, 3_000])(
    'checks a waiting pane once per frame however many closed panes sit ahead of it (%i)',
    async (count) => {
      const fakes = Array.from({ length: count }, fakePane)
      let verdicts = 0
      run(fakes, () => {
        verdicts++
        return 'wait'
      })
      for (const fake of fakes.slice(0, -1)) {
        fake.raw.container.isConnected = false
      }
      await vi.advanceTimersByTimeAsync(16)
      expect(verdicts).toBe(1)
    }
  )

  it('skips a pane that closed or lost its renderer before its frame', async () => {
    const [first, closed, lost] = Array.from({ length: 3 }, fakePane)
    run([first, closed, lost])
    closed.raw.container.isConnected = false
    lost.raw.webglAddon = null
    await vi.advanceTimersByTimeAsync(16 * 4)
    expect(attaches.count).toBe(1)
  })
})
