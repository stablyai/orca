import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'

const mocks = vi.hoisted(() => ({
  recordFeatureInteraction: vi.fn(),
  trackTerminalPaneSplit: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      recordFeatureInteraction: mocks.recordFeatureInteraction
    })
  }
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

describe('recordCreatedTerminalPaneSplit', () => {
  beforeEach(() => {
    mocks.recordFeatureInteraction.mockReset()
    mocks.trackTerminalPaneSplit.mockReset()
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
})
