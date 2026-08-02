import { describe, expect, it } from 'vitest'
import { shouldShutdownSimulatorForPaneUnmountFromTabs } from './simulator-tab-shutdown'

describe('shouldShutdownSimulatorForPaneUnmountFromTabs', () => {
  it('keeps the simulator alive when the same tab still exists during a remount', () => {
    expect(
      shouldShutdownSimulatorForPaneUnmountFromTabs(
        [{ id: 'sim-1', contentType: 'simulator' }],
        'sim-1'
      )
    ).toBe(false)
  })

  it('shuts down when the last simulator tab has been removed', () => {
    expect(
      shouldShutdownSimulatorForPaneUnmountFromTabs(
        [{ id: 'terminal-1', contentType: 'terminal' }],
        'sim-1'
      )
    ).toBe(true)
  })

  it('keeps the simulator alive when another simulator tab remains', () => {
    expect(
      shouldShutdownSimulatorForPaneUnmountFromTabs(
        [
          { id: 'terminal-1', contentType: 'terminal' },
          { id: 'sim-2', contentType: 'simulator' }
        ],
        'sim-1'
      )
    ).toBe(false)
  })
})
