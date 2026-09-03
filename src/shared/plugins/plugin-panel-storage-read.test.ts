import { describe, expect, it } from 'vitest'
import { PLUGIN_HOST_API_V0, isPluginPanelAction } from './plugin-host-api'

const byName = (name: string) => PLUGIN_HOST_API_V0.find((s) => s.name === name)

describe('panel-callable surface', () => {
  it('storage.get is callable from a panel, so a panel can render live state', () => {
    expect(isPluginPanelAction('storage.get')).toBe(true)
    expect(byName('storage.get')?.panel).toBe(true)
  })

  it('storage.get stays read-only and plugin-private', () => {
    const spec = byName('storage.get')
    expect(spec?.mutation).toBe(false)
    expect(spec?.scope).toBe('plugin-private')
    expect(spec?.capability).toBe('storage')
  })

  it('writes stay worker-only: a panel may observe state but never author it', () => {
    for (const name of ['storage.set', 'storage.delete']) {
      expect(isPluginPanelAction(name), `${name} must not be panel-callable`).toBe(false)
      expect(byName(name)?.panel).toBe(false)
    }
  })

  it('secrets remain entirely worker-only', () => {
    for (const name of ['secrets.get', 'secrets.set', 'secrets.delete']) {
      expect(isPluginPanelAction(name), `${name} must not be panel-callable`).toBe(false)
    }
  })

  it('every panel-callable method is still capability-gated', () => {
    for (const spec of PLUGIN_HOST_API_V0.filter((s) => s.panel)) {
      expect(spec.capability, `${spec.name} is panel-callable without a capability`).toBeTruthy()
    }
  })

  it('no panel-callable method mutates anything outside an explicit scope', () => {
    for (const spec of PLUGIN_HOST_API_V0.filter((s) => s.panel && s.mutation)) {
      expect(['explicit-terminal', 'desktop']).toContain(spec.scope)
    }
  })
})
