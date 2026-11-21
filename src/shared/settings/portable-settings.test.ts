import { describe, expect, it } from 'vitest'
import { createGlobalSettingsFixture } from './global-settings-test-fixture'
import { buildPortableSettingsFile, parsePortableSettingsFile } from './portable-settings'

describe('portable settings', () => {
  it('exports preferences but never accounts, cookies or machine paths', () => {
    const settings = createGlobalSettingsFixture({
      workspaceDir: 'C:\\Users\\someone\\orca',
      theme: 'dark',
      terminalFontSize: 15,
      opencodeSessionCookie: 'secret-cookie',
      httpProxyUrl: 'http://proxy.internal:8080',
      agentDefaultEnv: { claude: { ANTHROPIC_API_KEY: 'sk-secret' } },
      machineName: 'work-laptop'
    })

    const file = buildPortableSettingsFile(settings, new Date('2026-11-22T10:00:00.000Z'))

    expect(file).toMatchObject({
      format: 'orca-settings',
      version: 1,
      exportedAt: '2026-11-22T10:00:00.000Z'
    })
    expect(file.settings).toMatchObject({ theme: 'dark', terminalFontSize: 15 })
    const serialized = JSON.stringify(file)
    for (const leaked of [
      'secret-cookie',
      'sk-secret',
      'proxy.internal',
      'someone',
      'work-laptop'
    ]) {
      expect(serialized).not.toContain(leaked)
    }
  })

  it('imports only known settings whose values have the right type', () => {
    const result = parsePortableSettingsFile(
      JSON.stringify({
        format: 'orca-settings',
        version: 1,
        settings: {
          theme: 'light',
          terminalFontSize: 13,
          terminalCursorStyle: 'triangle',
          editorFontSize: '14',
          workspaceDir: '/home/someone/orca',
          claudeManagedAccounts: []
        }
      })
    )

    expect(result).toEqual({
      ok: true,
      settings: { theme: 'light', terminalFontSize: 13 },
      ignoredKeys: [
        'terminalCursorStyle',
        'editorFontSize',
        'workspaceDir',
        'claudeManagedAccounts'
      ]
    })
  })

  it('rejects files that are not a supported Orca settings export', () => {
    expect(parsePortableSettingsFile('{not json')).toEqual({ ok: false, reason: 'invalid-json' })
    expect(parsePortableSettingsFile(JSON.stringify({ theme: 'dark' }))).toEqual({
      ok: false,
      reason: 'not-orca-settings'
    })
    expect(
      parsePortableSettingsFile(
        JSON.stringify({ format: 'orca-settings', version: 2, settings: {} })
      )
    ).toEqual({ ok: false, reason: 'unsupported-version' })
  })
})
