import { expect, it } from 'vitest'
import { claudeFlaggedRequestEnv } from './claude-flagged-request-launch'

it('turns off the switch to a fallback model only when Stop is chosen', () => {
  expect(claudeFlaggedRequestEnv({ claudeFlaggedRequestAction: 'stop' })).toEqual({
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1'
  })
  for (const claudeFlaggedRequestAction of [undefined, 'switch-model', 'unknown-choice']) {
    expect(claudeFlaggedRequestEnv({ claudeFlaggedRequestAction })).toEqual({})
  }
  expect(claudeFlaggedRequestEnv(undefined)).toEqual({})
})
