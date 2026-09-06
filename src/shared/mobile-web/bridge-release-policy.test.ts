import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from './bridge-protocol-version'
import { MOBILE_WEB_PACKAGE_BRIDGE_RANGE } from './bridge-release-policy'

describe('mobile web bridge release policy', () => {
  it('keeps the packaged bridge range on the exact current contract', () => {
    expect(MOBILE_WEB_PACKAGE_BRIDGE_RANGE).toEqual({
      minimum: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      testedThrough: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    })
  })
})
