import { describe, expect, it } from 'vitest'
import { isDuplicateSshTargetAlias } from './ssh-target-duplicate'

describe('isDuplicateSshTargetAlias', () => {
  it('matches by configHost alias', () => {
    expect(
      isDuplicateSshTargetAlias({
        existingTargets: [{ configHost: 'staging', label: 'Staging', host: '10.0.0.1' }],
        configHost: 'staging',
        label: 'Staging box',
        host: 'staging.internal'
      })
    ).toBe(true)
  })

  it('matches by label when configHost is empty', () => {
    expect(
      isDuplicateSshTargetAlias({
        existingTargets: [{ label: 'prod-box', host: 'prod-box' }],
        configHost: '',
        label: 'prod-box',
        host: 'prod-box'
      })
    ).toBe(true)
  })

  it('matches case-only alias variants like the config picker does', () => {
    expect(
      isDuplicateSshTargetAlias({
        existingTargets: [{ configHost: 'Staging', label: 'Staging', host: '10.0.0.1' }],
        configHost: 'staging',
        label: 'staging',
        host: 'staging.internal'
      })
    ).toBe(true)
  })

  // Parity with the picker: it greys out an alias that matches either field, so saving
  // that same alias must be blocked rather than creating a second target for one host.
  it('matches an existing label even when that target has a different configHost', () => {
    expect(
      isDuplicateSshTargetAlias({
        existingTargets: [{ configHost: 'box1', label: 'prod', host: '10.0.0.1' }],
        configHost: 'Prod',
        label: 'Prod',
        host: 'prod.internal'
      })
    ).toBe(true)
  })

  it('returns false for a new alias', () => {
    expect(
      isDuplicateSshTargetAlias({
        existingTargets: [{ configHost: 'staging', label: 'staging', host: 's.example' }],
        configHost: 'prod',
        label: 'prod',
        host: 'p.example'
      })
    ).toBe(false)
  })
})
