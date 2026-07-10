import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordKeyboardCreatedTerminalPaneSplit } from './keyboard-handlers'
import { recordContextMenuCreatedTerminalPaneSplit } from './use-terminal-pane-context-menu'
import { recordRuntimeCreatedTerminalPaneSplit } from './use-terminal-pane-lifecycle'

const mocks = vi.hoisted(() => ({
  recordFeatureInteraction: vi.fn(),
  trackTerminalPaneSplit: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeContextualTourId: null,
      recordFeatureInteraction: mocks.recordFeatureInteraction
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
})
