import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'

const mocks = vi.hoisted(() => {
  const expandedPaneByTabId: Record<string, boolean> = {}
  return {
    recordFeatureInteraction: vi.fn(),
    trackTerminalPaneSplit: vi.fn(),
    equalizeTerminalPanes: vi.fn(),
    equalizePanesOnSplit: false,
    expandedPaneByTabId
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      recordFeatureInteraction: mocks.recordFeatureInteraction,
      settings: { terminalEqualizePanesOnSplit: mocks.equalizePanesOnSplit },
      expandedPaneByTabId: mocks.expandedPaneByTabId
    })
  }
}))

vi.mock('./terminal-pane-layout-owner-commands', () => ({
  equalizeTerminalPanes: mocks.equalizeTerminalPanes
}))

const equalizeTarget = { worktreeId: 'wt-1', tabId: 'tab-1', getManager: () => null }

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

describe('recordCreatedTerminalPaneSplit', () => {
  beforeEach(() => {
    mocks.recordFeatureInteraction.mockReset()
    mocks.trackTerminalPaneSplit.mockReset()
    mocks.equalizeTerminalPanes.mockReset()
    mocks.equalizePanesOnSplit = false
    mocks.expandedPaneByTabId = {}
  })

  it('does not record durable split completion when no pane was created', () => {
    expect(
      recordCreatedTerminalPaneSplit(null, {
        source: 'keyboard',
        direction: 'vertical'
      })
    ).toBe(false)

    expect(mocks.recordFeatureInteraction).not.toHaveBeenCalled()
    expect(mocks.trackTerminalPaneSplit).not.toHaveBeenCalled()
  })

  it('records durable split completion and telemetry after a pane is created', () => {
    expect(
      recordCreatedTerminalPaneSplit(
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
      recordCreatedTerminalPaneSplit(
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

  it('leaves pane sizes alone while the setting is off', () => {
    recordCreatedTerminalPaneSplit(
      { id: 2 },
      { source: 'keyboard', direction: 'vertical', equalizeTarget }
    )

    expect(mocks.equalizeTerminalPanes).not.toHaveBeenCalled()
  })

  it('equalizes the tab once through the shared equalize command when the setting is on', () => {
    mocks.equalizePanesOnSplit = true

    recordCreatedTerminalPaneSplit(
      { id: 2 },
      { source: 'keyboard', direction: 'vertical', equalizeTarget }
    )

    expect(mocks.equalizeTerminalPanes).toHaveBeenCalledOnce()
    expect(mocks.equalizeTerminalPanes).toHaveBeenCalledWith(equalizeTarget, expect.any(Function))
  })

  it('keeps stored ratios for splits that pass no equalize target', () => {
    mocks.equalizePanesOnSplit = true

    recordCreatedTerminalPaneSplit({ id: 2 }, { source: 'command', direction: 'vertical' })

    expect(mocks.equalizeTerminalPanes).not.toHaveBeenCalled()
  })

  it('skips equalizing while a pane in the tab is expanded', () => {
    mocks.equalizePanesOnSplit = true
    mocks.expandedPaneByTabId = { 'tab-1': true }

    recordCreatedTerminalPaneSplit(
      { id: 2 },
      { source: 'keyboard', direction: 'vertical', equalizeTarget }
    )

    expect(mocks.equalizeTerminalPanes).not.toHaveBeenCalled()
  })

  it('does not equalize when the split created no pane', () => {
    mocks.equalizePanesOnSplit = true

    recordCreatedTerminalPaneSplit(null, {
      source: 'keyboard',
      direction: 'vertical',
      equalizeTarget
    })

    expect(mocks.equalizeTerminalPanes).not.toHaveBeenCalled()
  })
})
