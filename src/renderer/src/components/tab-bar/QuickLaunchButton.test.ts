import { describe, expect, it } from 'vitest'
import { shouldShowLaunchWatchdogTimeout } from './QuickLaunchButton'

describe('shouldShowLaunchWatchdogTimeout', () => {
  it('does not report slow agent readiness once a PTY exists', () => {
    expect(
      shouldShowLaunchWatchdogTimeout({
        hasPty: true
      })
    ).toBe(false)
  })

  it('reports launches where no PTY appeared', () => {
    expect(
      shouldShowLaunchWatchdogTimeout({
        hasPty: false
      })
    ).toBe(true)
  })
})
