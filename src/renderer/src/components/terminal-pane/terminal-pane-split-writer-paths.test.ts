import { beforeEach, describe, expect, it, vi } from 'vitest'
import { completeKeyboardCreatedTerminalPaneSplit } from './keyboard-handlers'
import { completeContextMenuCreatedTerminalPaneSplit } from './use-terminal-pane-split-actions'
import { completeRuntimeCreatedTerminalPaneSplit } from './use-terminal-pane-lifecycle'

const mocks = vi.hoisted(() => ({
  recordFeatureInteraction: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  settings: { terminalEqualizePanesOnSplit: true } as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeContextualTourId: null,
      recordFeatureInteraction: mocks.recordFeatureInteraction,
      settings: mocks.settings,
      expandedPaneByTabId: {}
    })
  }
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

describe('terminal split writer paths', () => {
  beforeEach(() => {
    mocks.recordFeatureInteraction.mockReset()
    mocks.trackTerminalPaneSplit.mockReset()
    mocks.settings = { terminalEqualizePanesOnSplit: true }
  })

  it('does not record keyboard split completion when the local split fails', () => {
    expect(
      completeKeyboardCreatedTerminalPaneSplit(null, {
        source: 'keyboard',
        direction: 'vertical'
      })
    ).toBe(false)

    expect(mocks.recordFeatureInteraction).not.toHaveBeenCalled()
    expect(mocks.trackTerminalPaneSplit).not.toHaveBeenCalled()
  })

  it('records context-menu split completion after the local split succeeds', () => {
    expect(
      completeContextMenuCreatedTerminalPaneSplit(
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
      completeRuntimeCreatedTerminalPaneSplit(
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
      completeRuntimeCreatedTerminalPaneSplit(
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

  it.each([
    ['keyboard', completeKeyboardCreatedTerminalPaneSplit],
    ['context menu', completeContextMenuCreatedTerminalPaneSplit],
    ['runtime', completeRuntimeCreatedTerminalPaneSplit]
  ] as const)('equalizes panes on the %s split path when the setting is on', (_path, complete) => {
    const equalizePaneSizes = vi.fn<() => void>()

    complete(
      { id: 2 },
      {
        // Why: the only telemetry source all three writer paths accept.
        source: 'contextual_tour',
        direction: 'vertical',
        equalizeTarget: { tabId: 'tab-1', manager: { equalizePaneSizes } }
      }
    )

    expect(equalizePaneSizes).toHaveBeenCalledTimes(1)
  })
})
