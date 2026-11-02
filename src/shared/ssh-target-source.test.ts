import { describe, expect, it } from 'vitest'
import { isLegacyConfigImportTarget, isSshConfigSourcedTarget } from './ssh-target-source'

describe('isSshConfigSourcedTarget', () => {
  it('trusts an explicit source', () => {
    expect(isSshConfigSourcedTarget({ source: 'ssh-config', label: 'a', host: 'a' })).toBe(true)
    expect(
      isSshConfigSourcedTarget({
        source: 'manual',
        label: 'box',
        configHost: 'box',
        host: '10.0.0.5'
      })
    ).toBe(false)
  })

  it('counts a legacy target as imported only in the old import shape', () => {
    expect(isLegacyConfigImportTarget({ label: 'box', configHost: 'box', host: '10.0.0.5' })).toBe(
      true
    )
    // Alias equals the host: nothing was resolved, so it may be a hand-made target.
    expect(isLegacyConfigImportTarget({ label: 'box', configHost: 'box', host: 'box' })).toBe(false)
    expect(isSshConfigSourcedTarget({ label: 'My box', host: 'box.example.test' })).toBe(false)
  })
})
