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
  enforceTerminalCurrentScrollIntent: vi.fn()
}))
vi.mock('./pane-helpers', () => ({
  fitAndFocusPanes: vi.fn(),
  fitPanes: vi.fn(),
  focusActivePane: vi.fn()
}))
vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery: vi.fn()
}))

type FakeManager = {
  getPanes: ReturnType<typeof vi.fn>
  resumeRendering: ReturnType<typeof vi.fn>
  scheduleRevealRepaint: ReturnType<typeof vi.fn>
}

function createManager(order: string[] = []): FakeManager {
  return {
    getPanes: vi.fn(() => []),
    resumeRendering: vi.fn(() => order.push('resume-rendering')),
    scheduleRevealRepaint: vi.fn(() => order.push('reveal-repaint'))
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
  })

  it('schedules the repaint after rendering resumes on a heavy reveal', () => {
    const order: string[] = []
    const manager = createManager(order)
    resumeTerminalVisibility(resumeArgs(manager, false))

    expect(order).toEqual(['resume-rendering', 'reveal-repaint'])
  })

  it('schedules the repaint on window-wake recovery', () => {
    const manager = createManager()
    recoverVisibleTerminalWindowWake({
      manager: manager as never as PaneManager,
      isActive: false
    })

    expect(manager.scheduleRevealRepaint).toHaveBeenCalledTimes(1)
  })
})
