import { describe, expect, it } from 'vitest'
import { checkAgentLaunchModelPreferences } from './agent-launch-model-preferences'

// #45701 case 1: agy --effort accepts low|medium|high|xhigh|max, but the fallback catalog stopped at high.
describe('agent launch model preferences', () => {
  it('accepts every agy effort for an Antigravity model without cataloged per-model efforts', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(
        checkAgentLaunchModelPreferences({
          agent: 'antigravity',
          model: 'gemini-4-hydrogen',
          effort
        })
      ).toEqual({ preferences: { model: 'gemini-4-hydrogen', effort } })
    }
  })
})
