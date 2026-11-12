import { describe, expect, it } from 'vitest'
import { readPortableSettings } from './portable-settings'

describe('readPortableSettings', () => {
  it('keeps portable preferences and skips machine settings, secrets and refused values', () => {
    expect(
      readPortableSettings({
        theme: 'dark',
        terminalFontSize: 14,
        branchPrefix: 'custom',
        workspaceDir: '/Users/someone/orca/workspaces',
        machineName: 'laptop',
        claudeManagedAccounts: [],
        opencodeSessionCookie: 'cookie',
        pluginConsents: {},
        agentDefaultEnv: { claude: { API_KEY: 'secret' } },
        uiLanguage: 42,
        terminalCursorStyle: 'triangle',
        settingFromANewerOrca: true
      })
    ).toEqual({
      settings: { theme: 'dark', terminalFontSize: 14, branchPrefix: 'custom' },
      skipped: [
        'workspaceDir',
        'machineName',
        'claudeManagedAccounts',
        'opencodeSessionCookie',
        'pluginConsents',
        'agentDefaultEnv',
        'uiLanguage',
        'terminalCursorStyle',
        'settingFromANewerOrca'
      ]
    })
  })
})
