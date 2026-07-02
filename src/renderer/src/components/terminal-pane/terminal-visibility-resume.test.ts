import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resumeTerminalVisibility } from './terminal-visibility-resume'

const mocks = vi.hoisted(() => ({
  enforceTerminalCurrentScrollIntent: vi.fn(),
  fitAndFocusPanes: vi.fn(),
  fitPanes: vi.fn(),
  flushTerminalOutput: vi.fn(),
  focusActivePane: vi.fn(),
  requestTerminalBacklogRecovery: vi.fn(),
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalVisibilityWebglRecovery: vi.fn()
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', () => ({
  resetAndRefreshAllTerminalWebglAtlases: mocks.resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: mocks.flushTerminalOutput,
  requestTerminalBacklogRecovery: mocks.requestTerminalBacklogRecovery
}))

vi.mock('@/lib/pane-manager/terminal-scroll-intent', () => ({
  enforceTerminalCurrentScrollIntent: mocks.enforceTerminalCurrentScrollIntent
}))

vi.mock('./pane-helpers', () => ({
  fitAndFocusPanes: mocks.fitAndFocusPanes,
  fitPanes: mocks.fitPanes,
  focusActivePane: mocks.focusActivePane
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalVisibilityWebglRecovery: mocks.scheduleTerminalVisibilityWebglRecovery
}))

describe('resumeTerminalVisibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function createManager(): PaneManager {
    return {
      getPanes: vi.fn(() => [{ terminal: 'first-terminal' }, { terminal: 'second-terminal' }]),
      resumeRendering: vi.fn()
    } as unknown as PaneManager
  }

  function resume(
    options: {
      isActive?: boolean
      shouldUseLightTabResume?: boolean
      wasVisible?: boolean
    } = {}
  ): {
    captureViewportPositions: ReturnType<typeof vi.fn>
    manager: PaneManager
    withSuppressedScrollTracking: ReturnType<typeof vi.fn>
  } {
    const manager = createManager()
    const captureViewportPositions = vi.fn(() => new Map())
    const withSuppressedScrollTracking = vi.fn((callback: () => void) => callback())

    resumeTerminalVisibility({
      manager,
      isActive: options.isActive ?? true,
      wasVisible: options.wasVisible ?? false,
      shouldUseLightTabResume: options.shouldUseLightTabResume ?? true,
      captureViewportPositions,
      withSuppressedScrollTracking
    })

    return { captureViewportPositions, manager, withSuppressedScrollTracking }
  }

  it('uses visibility-owned WebGL recovery on light regular-tab resume', () => {
    const { captureViewportPositions, manager, withSuppressedScrollTracking } = resume()

    expect(captureViewportPositions).toHaveBeenCalledWith(true)
    expect(withSuppressedScrollTracking).toHaveBeenCalledTimes(1)
    expect(mocks.requestTerminalBacklogRecovery).toHaveBeenCalledWith('first-terminal')
    expect(mocks.requestTerminalBacklogRecovery).toHaveBeenCalledWith('second-terminal')
    expect(mocks.flushTerminalOutput).not.toHaveBeenCalled()
    expect(manager.resumeRendering).not.toHaveBeenCalled()
    expect(mocks.fitAndFocusPanes).not.toHaveBeenCalled()
    expect(mocks.fitPanes).not.toHaveBeenCalled()
    expect(mocks.scheduleTerminalVisibilityWebglRecovery).toHaveBeenCalledTimes(1)
    expect(mocks.resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
    expect(mocks.focusActivePane).toHaveBeenCalledWith(manager)
    expect(mocks.enforceTerminalCurrentScrollIntent).toHaveBeenCalledTimes(2)
  })

  it('preserves direct reset and refresh on heavy visibility resume', () => {
    const { manager } = resume({ shouldUseLightTabResume: false })

    expect(mocks.scheduleTerminalVisibilityWebglRecovery).not.toHaveBeenCalled()
    expect(mocks.requestTerminalBacklogRecovery).toHaveBeenCalledTimes(2)
    expect(mocks.flushTerminalOutput).toHaveBeenCalledTimes(2)
    expect(manager.resumeRendering).toHaveBeenCalledTimes(1)
    expect(mocks.fitAndFocusPanes).toHaveBeenCalledWith(manager)
    expect(mocks.resetAndRefreshAllTerminalWebglAtlases).toHaveBeenCalledTimes(1)
    expect(mocks.enforceTerminalCurrentScrollIntent).toHaveBeenCalledTimes(2)
  })
})
