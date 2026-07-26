import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  recoverVisibleTerminalWindowWake,
  resumeTerminalVisibility
} from './terminal-visibility-resume'

vi.mock('@/lib/pane-manager/pane-manager-registry', () => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn()
}))
vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: vi.fn(),
  requestTerminalBacklogRecovery: vi.fn()
}))
vi.mock('@/lib/pane-manager/terminal-scroll-intent', () => ({
  enforceTerminalCurrentScrollIntent: vi.fn(),
  syncTerminalScrollIntentFromViewport: vi.fn()
}))
vi.mock('./pane-helpers', () => ({
  fitAndFocusPanes: vi.fn(),
  fitPanes: vi.fn(),
  focusActivePane: vi.fn()
}))
const scheduleTabRevealWebglAtlasRecovery = vi.fn()
vi.mock('./terminal-webgl-atlas-recovery', () => ({
  // Why: the light-tab reveal must recover the atlas immediately, decoupled from
  // the terminal-output debounce (which a background stream could otherwise defer).
  scheduleTabRevealWebglAtlasRecovery: () => scheduleTabRevealWebglAtlasRecovery()
}))
const resetTerminalLinkifierHoverState = vi.fn()
const isTerminalLinkifierHoverActive = vi.fn((_terminal: unknown) => false)
vi.mock('@/lib/pane-manager/terminal-linkifier-hover-reset', () => ({
  resetTerminalLinkifierHoverState: (terminal: unknown) =>
    resetTerminalLinkifierHoverState(terminal),
  isTerminalLinkifierHoverActive: (terminal: unknown) => isTerminalLinkifierHoverActive(terminal)
}))

type FakeManager = {
  getPanes: ReturnType<typeof vi.fn>
  resumeRendering: ReturnType<typeof vi.fn>
  scheduleRevealRepaint: ReturnType<typeof vi.fn>
  scheduleRevealPresent: ReturnType<typeof vi.fn>
  fitAllPanes: ReturnType<typeof vi.fn>
  fitAllRevealedPanes: ReturnType<typeof vi.fn>
}

function createManager(order: string[] = []): FakeManager {
  return {
    getPanes: vi.fn(() => []),
    resumeRendering: vi.fn(() => order.push('resume-rendering')),
    scheduleRevealRepaint: vi.fn(() => order.push('reveal-repaint')),
    scheduleRevealPresent: vi.fn(() => order.push('reveal-present')),
    // Stubbed to assert reveals route through fitAllRevealedPanes, never fitAllPanes.
    fitAllPanes: vi.fn(() => order.push('fit-sync')),
    fitAllRevealedPanes: vi.fn(() => order.push('fit-reveal'))
  }
}

function resumeArgs(manager: FakeManager, shouldUseLightTabResume: boolean) {
  return {
    manager: manager as never as PaneManager,
    isActive: true,
    wasVisible: false,
    shouldUseLightTabResume,
    captureViewportPositions: vi.fn(() => new Map()),
    withSuppressedScrollTracking: (callback: () => void) => callback()
  }
}

describe('resumeTerminalVisibility reveal repaint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('schedules a pane-scoped repaint on a light tab reveal', () => {
    // The light path is the "click the tab that was not open" gesture: it has
    // no rendering resume or fit, so without this repaint a hidden-while-
    // working pane keeps compositing pre-hide pixels.
    const manager = createManager()
    resumeTerminalVisibility(resumeArgs(manager, true))

    expect(manager.scheduleRevealRepaint).toHaveBeenCalledTimes(1)
    expect(manager.resumeRendering).not.toHaveBeenCalled()
    // Reveal recovery is immediate (not the terminal-output debounce), so a
    // background stream in another pane cannot defer this tab's atlas rebuild.
    expect(scheduleTabRevealWebglAtlasRecovery).toHaveBeenCalledTimes(1)
  })

  it('captures native trim movement before enforcing viewport intent', async () => {
    const terminal = { name: 'trimmed-terminal' }
    const manager = createManager()
    manager.getPanes.mockReturnValue([{ terminal }])
    const { enforceTerminalCurrentScrollIntent, syncTerminalScrollIntentFromViewport } = vi.mocked(
      await import('@/lib/pane-manager/terminal-scroll-intent')
    )

    resumeTerminalVisibility(resumeArgs(manager, true))

    expect(syncTerminalScrollIntentFromViewport).toHaveBeenCalledWith(terminal)
    expect(syncTerminalScrollIntentFromViewport.mock.invocationCallOrder[0]).toBeLessThan(
      enforceTerminalCurrentScrollIntent.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('resets each pane linkifier hover cache on reveal so links recover without a scroll', () => {
    const first = { name: 'pane-a' }
    const second = { name: 'pane-b' }
    const manager = createManager()
    manager.getPanes.mockReturnValue([{ terminal: first }, { terminal: second }])

    resumeTerminalVisibility(resumeArgs(manager, false))

    expect(resetTerminalLinkifierHoverState).toHaveBeenCalledWith(first)
    expect(resetTerminalLinkifierHoverState).toHaveBeenCalledWith(second)
  })

  it('schedules the repaint after rendering resumes on a heavy reveal', () => {
    const order: string[] = []
    const manager = createManager(order)
    resumeTerminalVisibility(resumeArgs(manager, false))

    expect(order).toEqual(['resume-rendering', 'fit-reveal', 'reveal-repaint'])
  })

  it('routes a heavy reveal through fitAllRevealedPanes, not the sync fit', () => {
    // Regression: the sync reveal fit applied a transient one-column DOM↔WebGL grid, garbling grok on restore.
    const manager = createManager()
    resumeTerminalVisibility(resumeArgs(manager, false))

    expect(manager.fitAllRevealedPanes).toHaveBeenCalledTimes(1)
    expect(manager.fitAllPanes).not.toHaveBeenCalled()
  })

  it('does not fit on a light tab reveal', () => {
    const manager = createManager()
    resumeTerminalVisibility(resumeArgs(manager, true))

    expect(manager.fitAllRevealedPanes).not.toHaveBeenCalled()
    expect(manager.fitAllPanes).not.toHaveBeenCalled()
  })

  it('fits window wake recovery through the stable path, not the sync fit', () => {
    const manager = createManager()
    recoverVisibleTerminalWindowWake({
      manager: manager as never as PaneManager,
      isActive: true,
      clearGlyphAtlases: false
    })

    expect(manager.fitAllRevealedPanes).toHaveBeenCalledTimes(1)
    expect(manager.fitAllPanes).not.toHaveBeenCalled()
  })

  it('resets each pane linkifier hover cache on window wake recovery so links recover without a scroll', () => {
    const first = { name: 'pane-a' }
    const second = { name: 'pane-b' }
    const manager = createManager()
    manager.getPanes.mockReturnValue([{ terminal: first }, { terminal: second }])

    recoverVisibleTerminalWindowWake({
      manager: manager as never as PaneManager,
      isActive: true,
      clearGlyphAtlases: false
    })

    expect(resetTerminalLinkifierHoverState).toHaveBeenCalledWith(first)
    expect(resetTerminalLinkifierHoverState).toHaveBeenCalledWith(second)
  })

  it('keeps a genuinely-hovered link intact on window wake recovery', () => {
    const hovered = { name: 'hovered-pane' }
    const manager = createManager()
    manager.getPanes.mockReturnValue([{ terminal: hovered }])
    isTerminalLinkifierHoverActive.mockReturnValueOnce(true)

    recoverVisibleTerminalWindowWake({
      manager: manager as never as PaneManager,
      isActive: true,
      clearGlyphAtlases: false
    })

    expect(resetTerminalLinkifierHoverState).not.toHaveBeenCalled()
  })

  it('schedules the atlas-clearing repaint on genuine wake recovery', () => {
    const manager = createManager()
    recoverVisibleTerminalWindowWake({
      manager: manager as never as PaneManager,
      isActive: false,
      clearGlyphAtlases: true
    })

    expect(manager.scheduleRevealRepaint).toHaveBeenCalledTimes(1)
    expect(manager.scheduleRevealPresent).not.toHaveBeenCalled()
  })

  it('clears shared glyph atlases only on genuine wake recovery', async () => {
    const { resetAndRefreshAllTerminalWebglAtlases } = vi.mocked(
      await import('@/lib/pane-manager/pane-manager-registry')
    )
    const manager = createManager()
    recoverVisibleTerminalWindowWake({
      manager: manager as never as PaneManager,
      isActive: false,
      clearGlyphAtlases: true
    })

    expect(resetAndRefreshAllTerminalWebglAtlases).toHaveBeenCalledTimes(1)
  })

  it('keeps the warm glyph atlas on plain-refocus recovery', async () => {
    // Deliberate reversal of the #6354 focus-clear: wiping the shared atlas on
    // every refocus forces a mass re-rasterization that can hit xterm's atlas
    // page-merge race (#4480) and garble streaming panes. Focus recovery must
    // resume rendering and present WITHOUT the atlas-clearing reveal repaint —
    // scheduleRevealRepaint clears each pane's (shared) atlas, so the refocus
    // path must route to the atlas-preserving present instead.
    const { resetAndRefreshAllTerminalWebglAtlases } = vi.mocked(
      await import('@/lib/pane-manager/pane-manager-registry')
    )
    const manager = createManager()
    recoverVisibleTerminalWindowWake({
      manager: manager as never as PaneManager,
      isActive: false,
      clearGlyphAtlases: false
    })

    expect(resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
    expect(manager.resumeRendering).toHaveBeenCalledTimes(1)
    expect(manager.scheduleRevealPresent).toHaveBeenCalledTimes(1)
    expect(manager.scheduleRevealRepaint).not.toHaveBeenCalled()
  })
})
