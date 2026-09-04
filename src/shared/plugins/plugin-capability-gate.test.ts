import { describe, expect, it } from 'vitest'
import { gatePluginHostCall } from './plugin-capability-gate'
import type { PluginCapability } from './plugin-capabilities'

describe('gatePluginHostCall grants', () => {
  it('returns the exact scoped capability object', () => {
    const grant: PluginCapability = { kind: 'files:read', paths: ['docs/**'] }
    const decision = gatePluginHostCall(
      { grantedCapabilities: [grant], viaPanel: false },
      'files.read'
    )

    expect(decision).toEqual({ granted: true, grant })
    if (decision.granted) {
      expect(decision.grant).toBe(grant)
    }
  })

  it('returns the complete unscoped capability object', () => {
    const grant: PluginCapability = { kind: 'storage' }
    expect(
      gatePluginHostCall({ grantedCapabilities: [grant], viaPanel: false }, 'storage.get')
    ).toEqual({ granted: true, grant })
  })

  it.each([
    [null, 'consent_required'],
    [[], 'capability_denied'],
    [[{ kind: 'storage' }], 'capability_denied']
  ] as const)('denies missing or wrong authority', (grants, code) => {
    expect(
      gatePluginHostCall(
        { grantedCapabilities: grants as readonly PluginCapability[] | null, viaPanel: false },
        'files.read'
      )
    ).toMatchObject({ granted: false, code })
  })

  it('preserves unknown-method and panel precedence', () => {
    const grant: PluginCapability = { kind: 'files:read', paths: ['**'] }
    expect(
      gatePluginHostCall({ grantedCapabilities: [grant], viaPanel: true }, 'missing')
    ).toMatchObject({
      code: 'unknown_method'
    })
    expect(
      gatePluginHostCall({ grantedCapabilities: [grant], viaPanel: true }, 'files.read')
    ).toMatchObject({ code: 'panel_forbidden' })
  })
})
