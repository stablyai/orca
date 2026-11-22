import { describe, expect, it } from 'vitest'
import { checkAgentLaunchModelPreferences } from './agent-launch-model-preferences'

describe('antigravity level ids with --effort', () => {
  it('launches the family a chat menu lists, keeping the requested effort', () => {
    expect(
      checkAgentLaunchModelPreferences({
        agent: 'antigravity',
        model: 'gemini-4-argon-medium',
        effort: 'medium'
      })
    ).toEqual({ preferences: { model: 'gemini-4-argon', effort: 'medium' } })
    expect(
      checkAgentLaunchModelPreferences({
        agent: 'antigravity',
        model: 'gemini-4-argon-medium',
        effort: 'high'
      })
    ).toEqual({ preferences: { model: 'gemini-4-argon', effort: 'high' } })
  })
})
