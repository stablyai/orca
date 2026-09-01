import { describe, expect, it } from 'vitest'
import {
  AGENT_LAUNCH_NOTICE_CODES,
  agentLaunchNoticeCodeSchema,
  persistedLaunchNoticeStateSchema
} from './agent-launch-notice-schema'

describe('agent launch notice schema', () => {
  it('accepts every enum code and rejects a non-enum code (fail closed)', () => {
    for (const code of AGENT_LAUNCH_NOTICE_CODES) {
      expect(agentLaunchNoticeCodeSchema.safeParse(code).success).toBe(true)
    }
    expect(agentLaunchNoticeCodeSchema.safeParse('not_a_code').success).toBe(false)
    expect(agentLaunchNoticeCodeSchema.safeParse('').success).toBe(false)
  })

  it('validates persisted notice state and rejects a bad base agent or missing token', () => {
    expect(
      persistedLaunchNoticeStateSchema.safeParse({
        launchToken: 'tok',
        notices: [{ code: 'disabled_custom_fallback', label: 'My Claude', baseAgent: 'claude' }]
      }).success
    ).toBe(true)

    // Missing launchToken fails.
    expect(
      persistedLaunchNoticeStateSchema.safeParse({
        notices: [{ code: 'env_withheld', label: 'x' }]
      }).success
    ).toBe(false)

    // Fallback notice without a valid built-in base agent fails.
    expect(
      persistedLaunchNoticeStateSchema.safeParse({
        launchToken: 'tok',
        notices: [{ code: 'disabled_custom_fallback', label: 'x', baseAgent: 'not-an-agent' }]
      }).success
    ).toBe(false)
  })

  it('drops an unknown notice entry without rejecting its carrier', () => {
    expect(
      persistedLaunchNoticeStateSchema.parse({
        launchToken: 'tok',
        notices: [
          { code: 'future_notice', secret: 'ignored' },
          { code: 'vault_original_config_unavailable', baseAgent: 'codex' }
        ]
      })
    ).toEqual({
      launchToken: 'tok',
      notices: [{ code: 'vault_original_config_unavailable', baseAgent: 'codex' }]
    })
  })
})
