import { describe, expect, it } from 'vitest'
import { readPortableSettings } from './portable-settings'

describe('readPortableSettings', () => {
  it('keeps portable preferences and skips machine settings, secrets, refused values and selections the receiver may lack', () => {
    expect(
      readPortableSettings({
        theme: 'dark',
        terminalFontSize: 14,
        branchPrefix: 'custom',
        terminalThemeDark: 'Ghostty Default Style Dark',
        workspaceDir: '/Users/someone/orca/workspaces',
        machineName: 'laptop',
        claudeManagedAccounts: [],
        opencodeSessionCookie: 'cookie',
        pluginConsents: {},
        agentDefaultEnv: { claude: { API_KEY: 'secret' } },
        uiLanguage: 'plugin:acme.languages/fr',
        terminalThemeLight: 'custom:my-theme',
        terminalCursorStyle: 'triangle',
        settingFromANewerOrca: true
      })
    ).toEqual({
      settings: {
        theme: 'dark',
        terminalFontSize: 14,
        branchPrefix: 'custom',
        terminalThemeDark: 'Ghostty Default Style Dark'
      },
      skipped: [
        'workspaceDir',
        'machineName',
        'claudeManagedAccounts',
        'opencodeSessionCookie',
        'pluginConsents',
        'agentDefaultEnv',
        'uiLanguage',
        'terminalThemeLight',
        'terminalCursorStyle',
        'settingFromANewerOrca'
      ]
    })
  })
})
