import { describe, expect, it } from 'vitest'
import { applyZotzEnvAliases } from './zotz-env-aliases'

describe('applyZotzEnvAliases', () => {
  it('fills a missing ORCA_ variable from ZOTZ_ and keeps an explicit one', () => {
    const env: NodeJS.ProcessEnv = {
      ZOTZ_TELEMETRY_DISABLED: '1',
      ZOTZ_PROFILE: 'work',
      ORCA_PROFILE: 'home'
    }
    applyZotzEnvAliases(env)
    expect(env.ORCA_TELEMETRY_DISABLED).toBe('1')
    expect(env.ORCA_PROFILE).toBe('home')
  })
})
