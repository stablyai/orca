import { describe, expect, it } from 'vitest'
import { toAgentLaunchPreferences } from './agent-launch-preferences'

describe('toAgentLaunchPreferences', () => {
  it('keeps only supported string launch preferences', () => {
    expect(
      toAgentLaunchPreferences({
        model: ' gpt-5 ',
        effort: 'high',
        mode: 'plan',
        fastMode: true
      })
    ).toEqual({ model: 'gpt-5', effort: 'high', mode: 'plan' })
  })

  it('answers nothing when no preference survives', () => {
    expect(toAgentLaunchPreferences({ model: '  ', fastMode: true })).toBeUndefined()
    expect(toAgentLaunchPreferences(undefined)).toBeUndefined()
  })
})
