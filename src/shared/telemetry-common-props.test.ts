import { describe, expect, it } from 'vitest'
import { commonPropsSchema } from './telemetry-events'

describe('commonPropsSchema', () => {
  it('round-trips a realistic payload', () => {
    const parsed = commonPropsSchema.safeParse({
      app_version: '1.3.33',
      platform: 'darwin',
      arch: 'arm64',
      os_release: '25.3.0',
      install_id: '00000000-0000-4000-8000-000000000000',
      session_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      orca_channel: 'stable'
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects strings past the 64-char cap', () => {
    const parsed = commonPropsSchema.safeParse({
      app_version: 'x'.repeat(65),
      platform: 'darwin',
      arch: 'arm64',
      os_release: '25.3.0',
      install_id: '00000000-0000-4000-8000-000000000000',
      session_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      orca_channel: 'stable'
    })
    expect(parsed.success).toBe(false)
  })

  // Why: empty install/session IDs would collapse analytics across unrelated
  // installs or process lifetimes instead of preserving event attribution.
  it('rejects empty analytics identities', () => {
    const basePayload = {
      app_version: '1.3.33',
      platform: 'darwin',
      arch: 'arm64',
      os_release: '25.3.0',
      orca_channel: 'stable'
    }

    expect(
      commonPropsSchema.safeParse({
        ...basePayload,
        install_id: '',
        session_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      }).success
    ).toBe(false)
    expect(
      commonPropsSchema.safeParse({
        ...basePayload,
        install_id: '00000000-0000-4000-8000-000000000000',
        session_id: ''
      }).success
    ).toBe(false)
  })
})
