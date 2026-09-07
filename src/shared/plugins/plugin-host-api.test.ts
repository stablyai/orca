import { describe, expect, it } from 'vitest'
import { gatePluginHostCall } from './plugin-capability-gate'
import {
  PLUGIN_HOST_API_V0,
  PLUGIN_PANEL_ACTIONS,
  getPluginHostMethodSpec,
  isPluginPanelAction
} from './plugin-host-api'
import { parsePanelActionRequest } from './plugin-panel-bridge'

const STORAGE_METHODS = ['storage.get', 'storage.set', 'storage.delete', 'storage.keys'] as const
const SETTINGS_METHODS = ['settings.get', 'settings.set'] as const
const WORKER_ONLY = ['secrets.get', 'secrets.set', 'secrets.delete', 'events.subscribe'] as const

describe('PLUGIN_HOST_API_V0 panel surface', () => {
  it('lets sandboxed panels call plugin-private settings.get/set', () => {
    expect(PLUGIN_PANEL_ACTIONS).toEqual(expect.arrayContaining([...SETTINGS_METHODS]))
    for (const name of SETTINGS_METHODS) {
      expect(getPluginHostMethodSpec(name)?.panel).toBe(true)
      expect(isPluginPanelAction(name)).toBe(true)
    }
  })

  it('makes plugin-private storage.* panel-callable without new verbs', () => {
    expect(
      STORAGE_METHODS.every((name) => PLUGIN_HOST_API_V0.some((entry) => entry.name === name))
    ).toBe(true)
    for (const name of STORAGE_METHODS) {
      expect(getPluginHostMethodSpec(name)?.panel).toBe(true)
      expect(getPluginHostMethodSpec(name)?.scope).toBe('plugin-private')
      expect(isPluginPanelAction(name)).toBe(true)
      expect(PLUGIN_PANEL_ACTIONS).toContain(name)
    }
  })

  it('keeps secrets and events worker-only', () => {
    for (const name of WORKER_ONLY) {
      expect(getPluginHostMethodSpec(name)?.panel).toBe(false)
      expect(isPluginPanelAction(name), name).toBe(false)
    }
  })

  it('parses settings and storage panel requests and rejects secrets', () => {
    expect(
      parsePanelActionRequest({
        type: 'orca-panel-action',
        requestId: 'req-1',
        action: 'settings.get'
      }).ok
    ).toBe(true)
    expect(
      parsePanelActionRequest({
        type: 'orca-panel-action',
        requestId: 'req-2',
        action: 'settings.set',
        params: { key: 'theme', value: 'dark' }
      }).ok
    ).toBe(true)
    expect(
      parsePanelActionRequest({
        type: 'orca-panel-action',
        requestId: 'req-3',
        action: 'storage.get',
        params: { key: 'alpha' }
      }).ok
    ).toBe(true)
    expect(
      parsePanelActionRequest({
        type: 'orca-panel-action',
        requestId: 'req-4',
        action: 'secrets.get',
        params: { key: 'token' }
      })
    ).toMatchObject({ ok: false, requestId: 'req-4' })
  })

  it('gates panel settings to settings:own and panel storage to storage', () => {
    expect(
      gatePluginHostCall({ grantedCapabilities: ['settings:own'], viaPanel: true }, 'settings.get')
    ).toEqual({ granted: true })
    expect(
      gatePluginHostCall({ grantedCapabilities: ['settings:own'], viaPanel: true }, 'settings.set')
    ).toEqual({ granted: true })
    expect(
      gatePluginHostCall({ grantedCapabilities: ['storage'], viaPanel: true }, 'settings.get')
    ).toMatchObject({ granted: false, code: 'capability_denied' })
    expect(
      gatePluginHostCall({ grantedCapabilities: ['storage'], viaPanel: true }, 'storage.get')
    ).toEqual({ granted: true })
    expect(
      gatePluginHostCall({ grantedCapabilities: ['storage'], viaPanel: true }, 'storage.set')
    ).toEqual({ granted: true })
    expect(
      gatePluginHostCall({ grantedCapabilities: ['secrets'], viaPanel: true }, 'secrets.get')
    ).toMatchObject({ granted: false, code: 'panel_forbidden' })
  })

  it('lets panels poll ui.readFocus only with ui:focus', () => {
    expect(getPluginHostMethodSpec('ui.readFocus')?.panel).toBe(true)
    expect(getPluginHostMethodSpec('ui.readFocus')?.capability).toBe('ui:focus')
    expect(isPluginPanelAction('ui.readFocus')).toBe(true)
    expect(
      gatePluginHostCall({ grantedCapabilities: ['ui:focus'], viaPanel: true }, 'ui.readFocus')
    ).toEqual({ granted: true })
    expect(
      gatePluginHostCall(
        { grantedCapabilities: ['workspace:read'], viaPanel: true },
        'ui.readFocus'
      )
    ).toMatchObject({ granted: false, code: 'capability_denied' })
  })

  it('still denies storage when the plugin did not consent to it', () => {
    expect(
      gatePluginHostCall(
        { grantedCapabilities: ['notifications:show'], viaPanel: true },
        'storage.get'
      )
    ).toMatchObject({ granted: false, code: 'capability_denied' })
  })
})
