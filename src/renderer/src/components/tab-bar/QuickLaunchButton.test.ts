import { describe, expect, it } from 'vitest'
import {
  buildQuickLaunchAgentMenuOptions,
  shouldShowLaunchWatchdogTimeout
} from './QuickLaunchButton'

const claudeFooProfile = {
  id: 'agent-profile:claude-foo',
  baseAgent: 'claude',
  label: 'Claude (foo)',
  defaultArgs: '--foo'
} as const

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

describe('buildQuickLaunchAgentMenuOptions', () => {
  it('shows detected agent profiles under their base agent', () => {
    const options = buildQuickLaunchAgentMenuOptions(null, ['claude'], [], [claudeFooProfile])

    expect(options.map((option) => option.agent)).toEqual(['claude', 'agent-profile:claude-foo'])
    expect(options.map((option) => option.label)).toEqual(['Claude', 'Claude (foo)'])
  })

  it('can surface an enabled detected profile as the default', () => {
    const options = buildQuickLaunchAgentMenuOptions(
      'agent-profile:claude-foo',
      ['claude'],
      [],
      [claudeFooProfile]
    )

    expect(options.map((option) => option.agent)).toEqual(['agent-profile:claude-foo', 'claude'])
  })

  it('filters disabled profile and base agent ids', () => {
    expect(
      buildQuickLaunchAgentMenuOptions(
        null,
        ['claude'],
        ['agent-profile:claude-foo'],
        [claudeFooProfile]
      ).map((option) => option.agent)
    ).toEqual(['claude'])

    expect(
      buildQuickLaunchAgentMenuOptions(null, ['claude'], ['claude'], [claudeFooProfile]).map(
        (option) => option.agent
      )
    ).toEqual([])
  })
})
