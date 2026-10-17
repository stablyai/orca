import { describe, expect, it } from 'vitest'
import { gatePluginHostCall } from './plugin-capability-gate'
import { PLUGIN_SETTINGS_PAGE_LIMIT, parsePluginManifest } from './plugin-manifest'
import { parsePanelActionRequest } from './plugin-panel-bridge'

function manifest(overrides: { settingsPages?: unknown[]; capabilities?: { kind: string }[] }) {
  return {
    manifestVersion: 1,
    id: 'greeting',
    publisher: 'orca-samples',
    name: 'Greeting',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      settingsPages: overrides.settingsPages ?? [
        { id: 'preferences', title: 'Greeting settings', entry: 'settings.html' }
      ]
    },
    capabilities: overrides.capabilities ?? [{ kind: 'settingsPage' }, { kind: 'settings:own' }]
  }
}

describe('contributes.settingsPages', () => {
  it('accepts settings pages without a worker', () => {
    const parsed = parsePluginManifest(manifest({}))
    expect(parsed.ok && parsed.manifest.contributes.settingsPages).toEqual([
      { id: 'preferences', title: 'Greeting settings', entry: 'settings.html' }
    ])
  })

  it.each([
    [{ capabilities: [{ kind: 'settings:own' }] }, 'settingsPage capability required'],
    [
      {
        settingsPages: [
          { id: 'preferences', title: 'A', entry: 'a.html' },
          { id: 'preferences', title: 'B', entry: 'b.html' }
        ]
      },
      'duplicate settingsPages id'
    ],
    [{ settingsPages: [{ id: 'preferences', title: 'A', entry: '../a.html' }] }, 'relative path'],
    [{ settingsPages: [{ id: 'preferences', title: '', entry: 'a.html' }] }, 'title']
  ])('rejects %j', (overrides, error) => {
    const parsed = parsePluginManifest(manifest(overrides))
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.error).toContain(error)
  })

  it('caps the number of settings pages', () => {
    const pages = Array.from({ length: PLUGIN_SETTINGS_PAGE_LIMIT + 1 }, (_, index) => ({
      id: `page-${index}`,
      title: `Page ${index}`,
      entry: 'settings.html'
    }))
    expect(parsePluginManifest(manifest({ settingsPages: pages })).ok).toBe(false)
  })
})

describe('settings page bridge surface', () => {
  const granted = ['settings:own', 'storage', 'notifications:show'] as const

  it('lets settings pages, and only settings pages, use the settings methods', () => {
    const settingsPage = { grantedCapabilities: granted, viaPanel: true, viaSettingsPage: true }
    const panel = { grantedCapabilities: granted, viaPanel: true }
    expect(gatePluginHostCall(settingsPage, 'settings.get')).toEqual({ granted: true })
    expect(gatePluginHostCall(settingsPage, 'settings.set')).toEqual({ granted: true })
    expect(gatePluginHostCall(settingsPage, 'notifications.show')).toEqual({ granted: true })
    expect(gatePluginHostCall(settingsPage, 'storage.get')).toMatchObject({
      code: 'panel_forbidden'
    })
    expect(gatePluginHostCall(panel, 'settings.set')).toMatchObject({ code: 'panel_forbidden' })
  })

  it('still requires the settings:own capability', () => {
    expect(
      gatePluginHostCall(
        { grantedCapabilities: ['settingsPage'], viaPanel: true, viaSettingsPage: true },
        'settings.set'
      )
    ).toMatchObject({ code: 'capability_denied' })
  })

  it('parses settings actions only for the settings page surface', () => {
    const request = {
      type: 'orca-panel-action',
      requestId: 'req-1',
      action: 'settings.set',
      params: { key: 'greeting', value: 'Hi' }
    }
    expect(parsePanelActionRequest(request, 'settingsPage')).toMatchObject({ ok: true })
    expect(parsePanelActionRequest(request)).toMatchObject({ ok: false, requestId: 'req-1' })
    expect(
      parsePanelActionRequest({ ...request, action: 'storage.set' }, 'settingsPage')
    ).toMatchObject({ ok: false })
  })
})
