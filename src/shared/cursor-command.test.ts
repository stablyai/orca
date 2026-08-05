import { describe, expect, it } from 'vitest'
import { resolveEffectiveCursorCommand } from './cursor-command'

describe('resolveEffectiveCursorCommand', () => {
  it('prefers an explicit override over host inventory', () => {
    expect(
      resolveEffectiveCursorCommand(' custom-cursor ', {
        version: 1,
        agents: ['cursor'],
        matchedCommands: { cursor: 'cursor-agent' }
      })
    ).toBe('custom-cursor')
  })

  it.each([
    ['cursor-agent', 'cursor-agent'],
    ['cursor agent', 'cursor agent']
  ])('maps the detected %s form to %s', (matched, expected) => {
    expect(
      resolveEffectiveCursorCommand(null, {
        version: 1,
        agents: ['cursor'],
        matchedCommands: { cursor: matched }
      })
    ).toBe(expected)
  })

  it('does not accept an unprobed cursor executable match', () => {
    expect(
      resolveEffectiveCursorCommand(null, {
        version: 1,
        agents: ['cursor'],
        matchedCommands: { cursor: 'cursor' }
      })
    ).toBeNull()
  })

  it('does not infer availability from an agent id without a matched command', () => {
    expect(
      resolveEffectiveCursorCommand(null, {
        version: 1,
        agents: ['cursor'],
        matchedCommands: {}
      })
    ).toBeNull()
  })
})
