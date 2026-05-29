import { describe, expect, it } from 'vitest'
import { orderAgents, shouldShowLaunchWatchdogTimeout } from './QuickLaunchButton'

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

describe('orderAgents', () => {
  it('keeps detected built-ins first and appends ready custom agents sorted by label', () => {
    expect(
      orderAgents(
        null,
        ['codex', 'claude'],
        [
          {
            id: 'custom:zeta-abc123',
            label: 'Zeta CLI',
            command: 'zeta',
            promptInjectionMode: 'stdin-after-start'
          },
          {
            id: 'custom:alpha-abc123',
            label: 'Alpha CLI',
            command: 'alpha',
            promptInjectionMode: 'stdin-after-start'
          },
          {
            id: 'custom:empty-abc123',
            label: 'Empty CLI',
            command: '',
            promptInjectionMode: 'stdin-after-start'
          }
        ]
      )
    ).toEqual(['claude', 'codex', 'custom:alpha-abc123', 'custom:zeta-abc123'])
  })

  it('moves a ready custom default to the front', () => {
    expect(
      orderAgents(
        'custom:alpha-abc123',
        ['claude'],
        [
          {
            id: 'custom:alpha-abc123',
            label: 'Alpha CLI',
            command: 'alpha',
            promptInjectionMode: 'stdin-after-start'
          }
        ]
      )
    ).toEqual(['custom:alpha-abc123', 'claude'])
  })
})
