import { describe, expect, it } from 'vitest'
import { eventSchemas } from './telemetry-events'

describe('profile state authority telemetry', () => {
  it('accepts the bounded startup selection payload', () => {
    expect(
      eventSchemas.profile_state_authority_selected.safeParse({
        backend: 'sqlite',
        classification: 'json-only',
        authority_mode: 'sqlite-candidate',
        runtime: 'desktop',
        migrated: true
      }).success
    ).toBe(true)
  })

  it('rejects paths or other unbounded diagnostic fields', () => {
    expect(
      eventSchemas.profile_state_authority_selected.safeParse({
        backend: 'sqlite',
        classification: 'sqlite-only',
        authority_mode: 'sqlite-established',
        runtime: 'desktop',
        migrated: false,
        database_path: '/private/profile.sqlite'
      }).success
    ).toBe(false)
  })
})
