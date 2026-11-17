import { describe, expect, it } from 'vitest'
import { getUsageProviderAccountsSectionId } from './usage-provider-settings-target'

describe('getUsageProviderAccountsSectionId', () => {
  it('has no Orca account settings to open for Kiro, since kiro-cli owns the login', () => {
    expect(getUsageProviderAccountsSectionId('kiro')).toBeNull()
  })
})
