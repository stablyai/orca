import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordKeyboardCreatedTerminalPaneSplit } from './terminal-keyboard-shortcut-matching'
import { recordContextMenuCreatedTerminalPaneSplit } from './use-terminal-pane-split-actions'
import { recordRuntimeCreatedTerminalPaneSplit } from './terminal-pane-lifecycle-primitives'

const mocks = vi.hoisted(() => ({
  recordFeatureInteraction: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  equalizeTerminalPanes: vi.fn(),
  equalizePanesOnSplit: false
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeContextualTourId: null,
      recordFeatureInteraction: mocks.recordFeatureInteraction,
      settings: { terminalEqualizePanesOnSplit: mocks.equalizePanesOnSplit },
      expandedPaneByTabId: {}
    })
  }
}))

vi.mock('./terminal-pane-layout-owner-commands', () => ({
  equalizeTerminalPanes: mocks.equalizeTerminalPanes
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

describe('terminal split writer paths', () => {
  beforeEach(() => {
    mocks.recordFeatureInteraction.mockReset()
    mocks.trackTerminalPaneSplit.mockReset()
    mocks.equalizeTerminalPanes.mockReset()
    mocks.equalizePanesOnSplit = false
  })

  it('does not record keyboard split completion when the local split fails', () => {
    expect(
      recordKeyboardCreatedTerminalPaneSplit(null, {
        source: 'keyboard',
        direction: 'vertical'
      })
    ).toBe(false)

    expect(mocks.recordFeatureInteraction).not.toHaveBeenCalled()
    expect(mocks.trackTerminalPaneSplit).not.toHaveBeenCalled()
  })

  it('records context-menu split completion after the local split succeeds', () => {
    expect(
      recordContextMenuCreatedTerminalPaneSplit(
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

  it('records runtime split completion after SPLIT_TERMINAL_PANE_EVENT creates a pane', () => {
    expect(
      recordRuntimeCreatedTerminalPaneSplit(
        { id: 2 },
        {
          source: 'command',
          direction: 'vertical'
        }
      )
    ).toBe(true)

    expect(mocks.recordFeatureInteraction).toHaveBeenCalledWith('terminal-pane-split')
    expect(mocks.trackTerminalPaneSplit).toHaveBeenCalledWith({
      source: 'command',
      direction: 'vertical'
    })
  })

  it('keeps runtime split completion when mirrored telemetry is suppressed', () => {
    expect(
      recordRuntimeCreatedTerminalPaneSplit(
        { id: 2 },
        {
          source: 'command',
          direction: 'horizontal',
          telemetrySuppressed: true
        }
      )
    ).toBe(true)

    expect(mocks.recordFeatureInteraction).toHaveBeenCalledWith('terminal-pane-split')
    expect(mocks.trackTerminalPaneSplit).not.toHaveBeenCalled()
  })

  it('equalizes a runtime split that carries the tab as its equalize target', () => {
    mocks.equalizePanesOnSplit = true
    const equalizeTarget = { worktreeId: 'wt-1', tabId: 'tab-1', getManager: () => null }

    recordRuntimeCreatedTerminalPaneSplit(
      { id: 2 },
      { source: 'command', direction: 'vertical', telemetrySuppressed: true, equalizeTarget }
    )

    expect(mocks.equalizeTerminalPanes).toHaveBeenCalledOnce()
    expect(mocks.equalizeTerminalPanes).toHaveBeenCalledWith(equalizeTarget, expect.any(Function))
  })
})
