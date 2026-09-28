import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  completeCreatedTerminalPaneSplit,
  type TerminalPaneSplitEqualizeTarget
} from './terminal-pane-split-completion'

const mocks = vi.hoisted(() => ({
  recordFeatureInteraction: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  settings: { terminalEqualizePanesOnSplit: false } as Record<string, unknown> | null,
  expandedPaneByTabId: {} as Record<string, boolean>
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      recordFeatureInteraction: mocks.recordFeatureInteraction,
      settings: mocks.settings,
      expandedPaneByTabId: mocks.expandedPaneByTabId
    })
  }
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

function makeEqualizeTarget(): TerminalPaneSplitEqualizeTarget & {
  manager: { equalizePaneSizes: Mock<() => void> }
} {
  return { tabId: 'tab-1', manager: { equalizePaneSizes: vi.fn<() => void>() } }
}

describe('completeCreatedTerminalPaneSplit', () => {
  beforeEach(() => {
    mocks.recordFeatureInteraction.mockReset()
    mocks.trackTerminalPaneSplit.mockReset()
    mocks.settings = { terminalEqualizePanesOnSplit: false }
    mocks.expandedPaneByTabId = {}
  })

  it('does not record durable split completion when no pane was created', () => {
    expect(
      completeCreatedTerminalPaneSplit(null, {
        source: 'keyboard',
        direction: 'vertical'
      })
    ).toBe(false)

    expect(mocks.recordFeatureInteraction).not.toHaveBeenCalled()
    expect(mocks.trackTerminalPaneSplit).not.toHaveBeenCalled()
  })

  it('records durable split completion and telemetry after a pane is created', () => {
    expect(
      completeCreatedTerminalPaneSplit(
        { id: 2 },
        {
          source: 'context_menu',
          direction: 'horizontal'
        }
      )
    ).toBe(true)

    expect(mocks.recordFeatureInteraction).toHaveBeenCalledWith('terminal-pane-split')
    expect(mocks.trackTerminalPaneSplit).toHaveBeenCalledWith({
      source: 'context_menu',
      direction: 'horizontal'
    })
  })

  it('keeps durable split completion when mirrored runtime telemetry is suppressed', () => {
    expect(
      completeCreatedTerminalPaneSplit(
        { id: 2 },
        {
          source: 'command',
          direction: 'vertical',
          telemetrySuppressed: true
        }
      )
    ).toBe(true)

    expect(mocks.recordFeatureInteraction).toHaveBeenCalledWith('terminal-pane-split')
    expect(mocks.trackTerminalPaneSplit).not.toHaveBeenCalled()
  })

  it('equalizes the tab after a split when terminalEqualizePanesOnSplit is on', () => {
    mocks.settings = { terminalEqualizePanesOnSplit: true }
    const target = makeEqualizeTarget()

    completeCreatedTerminalPaneSplit(
      { id: 2 },
      { source: 'keyboard', direction: 'vertical', equalizeTarget: target }
    )

    expect(target.manager.equalizePaneSizes).toHaveBeenCalledTimes(1)
  })

  it('leaves split ratios alone when the setting is off', () => {
    const target = makeEqualizeTarget()

    completeCreatedTerminalPaneSplit(
      { id: 2 },
      { source: 'keyboard', direction: 'vertical', equalizeTarget: target }
    )

    expect(target.manager.equalizePaneSizes).not.toHaveBeenCalled()
  })

  it('does not equalize when the split failed', () => {
    mocks.settings = { terminalEqualizePanesOnSplit: true }
    const target = makeEqualizeTarget()

    completeCreatedTerminalPaneSplit(null, {
      source: 'keyboard',
      direction: 'vertical',
      equalizeTarget: target
    })

    expect(target.manager.equalizePaneSizes).not.toHaveBeenCalled()
  })

  it('does not equalize while the tab has an expanded pane', () => {
    mocks.settings = { terminalEqualizePanesOnSplit: true }
    mocks.expandedPaneByTabId = { 'tab-1': true }
    const target = makeEqualizeTarget()

    completeCreatedTerminalPaneSplit(
      { id: 2 },
      { source: 'keyboard', direction: 'vertical', equalizeTarget: target }
    )

    expect(target.manager.equalizePaneSizes).not.toHaveBeenCalled()
  })

  it('does not equalize for callers that rebuild a persisted layout', () => {
    mocks.settings = { terminalEqualizePanesOnSplit: true }

    expect(
      completeCreatedTerminalPaneSplit({ id: 2 }, { source: 'command', direction: 'vertical' })
    ).toBe(true)

    expect(mocks.recordFeatureInteraction).toHaveBeenCalledWith('terminal-pane-split')
  })

  it('tolerates settings that have not hydrated yet', () => {
    mocks.settings = null
    const target = makeEqualizeTarget()

    completeCreatedTerminalPaneSplit(
      { id: 2 },
      { source: 'keyboard', direction: 'vertical', equalizeTarget: target }
    )

    expect(target.manager.equalizePaneSizes).not.toHaveBeenCalled()
  })
})
