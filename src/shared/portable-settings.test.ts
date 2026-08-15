import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  createPortableSettingsBundle,
  getPortableSettingsCategoryDifferences,
  PortableSettingsBundleSchema,
  remapPortableKeybindingOverrides
} from './portable-settings'

describe('portable settings', () => {
  it('includes allowlisted preferences without credentials or machine paths', () => {
    const settings = {
      ...getDefaultSettings('/home/test'),
      theme: 'dark' as const,
      workspaceDir: '/private/workspaces',
      opencodeSessionCookie: 'secret-cookie',
      claudeManagedAccounts: [
        {
          id: 'secret-account',
          name: 'Secret',
          createdAt: 1,
          managedAuthPath: '/private/auth.json'
        }
      ] as never,
      agentDefaultEnv: { claude: { API_KEY: 'secret' } },
      terminalCustomThemes: [
        {
          id: 'night',
          name: 'Night',
          source: 'ghostty' as const,
          mode: 'dark' as const,
          terminal: { background: '#000000' },
          importedAt: '2026-07-18T00:00:00.000Z',
          sourceLabel: '/private/themes/night.conf'
        }
      ]
    }
    const bundle = createPortableSettingsBundle(settings, {
      platform: 'darwin',
      overrides: { 'app.settings': ['Cmd+Comma'] }
    })
    const serialized = JSON.stringify(bundle)

    expect(bundle.categories.appearance.theme).toBe('dark')
    expect(bundle.categories.input.keybindings.overrides).toEqual({
      'app.settings': ['Cmd+Comma']
    })
    expect(bundle.categories.appearance.terminalCustomThemes?.[0]).toMatchObject({
      id: 'night',
      terminal: { background: '#000000' }
    })
    expect(serialized).not.toContain('secret-cookie')
    expect(serialized).not.toContain('secret-account')
    expect(serialized).not.toContain('API_KEY')
    expect(serialized).not.toContain('/private')
  })

  it('reports category-level differences including keybindings', () => {
    const source = createPortableSettingsBundle(
      { ...getDefaultSettings('/home/test'), theme: 'dark' },
      { platform: 'darwin', overrides: { 'app.settings': ['Cmd+Comma'] } }
    )
    const target = createPortableSettingsBundle(getDefaultSettings('/home/test'), {
      platform: 'darwin',
      overrides: {}
    })

    expect(getPortableSettingsCategoryDifferences(source, target, 'appearance')).toContain('theme')
    expect(getPortableSettingsCategoryDifferences(source, target, 'input')).toContain('keybindings')
  })

  it('compares keybindings after mapping them to the target platform', () => {
    const source = createPortableSettingsBundle(getDefaultSettings('/home/source'), {
      platform: 'darwin',
      overrides: { 'app.settings': ['Cmd+Comma'] }
    })
    const target = createPortableSettingsBundle(getDefaultSettings('/home/target'), {
      platform: 'linux',
      overrides: { 'app.settings': ['Ctrl+Comma'] }
    })

    expect(getPortableSettingsCategoryDifferences(source, target, 'input')).not.toContain(
      'keybindings'
    )
  })

  it('maps the source primary modifier onto the target platform', () => {
    expect(
      remapPortableKeybindingOverrides(
        { 'app.settings': ['Cmd+Shift+,'], 'terminal.clear': ['Ctrl+L'] },
        'darwin',
        'linux'
      )
    ).toEqual({
      'app.settings': ['Ctrl+Shift+,'],
      'terminal.clear': ['Ctrl+L']
    })
    expect(
      remapPortableKeybindingOverrides({ 'app.settings': ['Ctrl+Comma'] }, 'win32', 'darwin')
    ).toEqual({ 'app.settings': ['Cmd+Comma'] })
  })

  it('rejects unknown settings and keybinding actions at the RPC boundary', () => {
    const bundle = createPortableSettingsBundle(getDefaultSettings('/home/test'), {
      platform: 'linux',
      overrides: {}
    })

    expect(
      PortableSettingsBundleSchema.safeParse({
        ...bundle,
        categories: {
          ...bundle.categories,
          appearance: { ...bundle.categories.appearance, opencodeSessionCookie: 'secret' }
        }
      }).success
    ).toBe(false)
    expect(
      PortableSettingsBundleSchema.safeParse({
        ...bundle,
        categories: {
          ...bundle.categories,
          input: {
            ...bundle.categories.input,
            keybindings: {
              sourcePlatform: 'linux',
              overrides: { 'unknown.action': ['Ctrl+K'] }
            }
          }
        }
      }).success
    ).toBe(false)
  })
})
