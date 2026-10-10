import { describe, expect, it } from 'vitest'
import { gatePluginHostCall } from './plugin-capability-gate'
import { PLUGIN_HOST_API_V0, getPluginHostMethodSpec } from './plugin-host-api'

describe('gatePluginHostCall', () => {
  it('keeps a capability required on every row except explicit null rows', () => {
    const nullRows = PLUGIN_HOST_API_V0.filter((entry) => entry.capability === null)
    expect(nullRows.map((entry) => entry.name)).toEqual(['commands.invoke'])
  })

  it('only marks panel-callable rows as panelOnly', () => {
    const panelOnly = PLUGIN_HOST_API_V0.filter((entry) => entry.panelOnly)
    expect(panelOnly.map((entry) => entry.name)).toEqual(['commands.invoke'])
    expect(panelOnly.every((entry) => entry.panel)).toBe(true)
  })

  it('grants a null-capability row to a consented panel without any capability kind', () => {
    expect(
      gatePluginHostCall({ grantedCapabilities: [], viaPanel: true }, 'commands.invoke')
    ).toEqual({
      granted: true
    })
  })

  it('denies a null-capability row without current consent', () => {
    expect(
      gatePluginHostCall({ grantedCapabilities: null, viaPanel: true }, 'commands.invoke')
    ).toMatchObject({ granted: false, code: 'consent_required' })
  })

  it('denies a worker caller on a panelOnly row even with every capability', () => {
    expect(
      gatePluginHostCall(
        { grantedCapabilities: ['storage', 'workspace:read'], viaPanel: false },
        'commands.invoke'
      )
    ).toMatchObject({ granted: false, code: 'worker_forbidden' })
  })

  it('still lets workers call non-panelOnly rows and gates their capability', () => {
    expect(getPluginHostMethodSpec('storage.get')?.panelOnly).toBeFalsy()
    expect(
      gatePluginHostCall({ grantedCapabilities: ['storage'], viaPanel: false }, 'storage.get')
    ).toEqual({
      granted: true
    })
    expect(
      gatePluginHostCall({ grantedCapabilities: [], viaPanel: false }, 'storage.get')
    ).toMatchObject({
      granted: false,
      code: 'capability_denied'
    })
    expect(
      gatePluginHostCall({ grantedCapabilities: [], viaPanel: true }, 'workspace.readContext')
    ).toMatchObject({
      granted: false,
      code: 'capability_denied'
    })
  })
})
