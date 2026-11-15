import { describe, expect, it } from 'vitest'
import { PLUGIN_HOST_API_MINOR } from './plugin-host-api'
import { PLUGIN_HOST_API_MINOR_SINCE } from './plugin-host-api-releases'

describe('host API minor releases', () => {
  // Why: without a release for the newest minor, the validator cannot check engines.orca.
  it('names a release for every minor this build implements', () => {
    expect(PLUGIN_HOST_API_MINOR_SINCE).toHaveLength(PLUGIN_HOST_API_MINOR + 1)
  })
})
