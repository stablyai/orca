import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  createSettingsExportDocument,
  getPortableSettingsFromExport,
  previewSettingsExportImport,
  type SettingsExportDocument,
  SETTINGS_EXPORT_KIND
} from './settings-portability'

describe('settings portability', () => {
  it('exports portable settings while omitting machine-local and secret fields', () => {
    const document = createSettingsExportDocument({
      ...getDefaultSettings('/Users/test'),
      theme: 'dark',
      workspaceDir: '/Users/test/orca/workspaces',
      floatingTerminalTrustedCwds: ['/Users/test/project'],
      opencodeSessionCookie: 'secret-cookie',
      httpProxyUrl: 'http://proxy.example:8080',
      terminalColorOverrides: {
        foreground: '#ffffff',
        apiKey: 'color-secret'
      },
      terminalQuickCommands: [
        {
          id: 'global-command',
          label: 'Global command',
          scope: { type: 'global' },
          action: 'terminal-command',
          command: 'echo hi',
          appendEnter: true,
          token: 'quick-command-secret'
        },
        {
          id: 'repo-command',
          label: 'Repo command',
          scope: { type: 'repo', repoId: 'repo-id-from-another-machine' },
          action: 'terminal-command',
          command: 'npm test',
          appendEnter: true
        }
      ],
      agentCmdOverrides: {
        claude: 'claude',
        apiKey: 'agent-secret'
      },
      voice: {
        ...getDefaultSettings('/Users/test').voice!,
        modelsDir: '/Users/test/models',
        userModels: [{ id: 'custom-model', type: 'whisper' as const, dir: '/Users/test/model' }],
        openAiApiKeyConfigured: true,
        openAiApiKey: 'sk-secret'
      },
      telemetry: {
        optedIn: true,
        installId: 'install-id',
        existedBeforeTelemetryRelease: false
      }
    } as ReturnType<typeof getDefaultSettings> & {
      voice: NonNullable<ReturnType<typeof getDefaultSettings>['voice']> & {
        openAiApiKey: string
      }
      terminalColorOverrides: NonNullable<
        ReturnType<typeof getDefaultSettings>['terminalColorOverrides']
      > & { apiKey: string }
      terminalQuickCommands: NonNullable<
        ReturnType<typeof getDefaultSettings>['terminalQuickCommands']
      >
      agentCmdOverrides: ReturnType<typeof getDefaultSettings>['agentCmdOverrides'] & {
        apiKey: string
      }
    })

    expect(document.kind).toBe(SETTINGS_EXPORT_KIND)
    expect(document.settings.theme).toBe('dark')
    expect(document.settings.workspaceDir).toBeUndefined()
    expect(document.settings.floatingTerminalTrustedCwds).toBeUndefined()
    expect(document.settings.opencodeSessionCookie).toBeUndefined()
    expect(document.settings.httpProxyUrl).toBeUndefined()
    expect(document.settings.terminalColorOverrides).toEqual({ foreground: '#ffffff' })
    expect(document.settings.terminalQuickCommands).toEqual([
      {
        id: 'global-command',
        label: 'Global command',
        scope: { type: 'global' },
        action: 'terminal-command',
        command: 'echo hi',
        appendEnter: true
      }
    ])
    expect(document.settings.agentCmdOverrides).toEqual({ claude: 'claude' })
    expect(document.settings.voice).toMatchObject({
      modelsDir: '',
      userModels: [],
      openAiApiKeyConfigured: false
    })
    expect(document.settings.voice).not.toHaveProperty('openAiApiKey')
    expect(document.settings.telemetry).toBeUndefined()
  })

  it('strips nested voice secrets and local paths from imported exports', () => {
    const document = {
      ...createSettingsExportDocument(getDefaultSettings('/Users/test')),
      settings: {
        voice: {
          ...getDefaultSettings('/Users/test').voice!,
          modelsDir: '/Users/test/models',
          userModels: [{ id: 'custom-model', type: 'whisper' as const, dir: '/Users/test/model' }],
          openAiApiKeyConfigured: true,
          openAiApiKey: 'sk-secret'
        }
      }
    } as unknown as SettingsExportDocument

    expect(getPortableSettingsFromExport(document).settings.voice).toEqual({
      ...getDefaultSettings('/Users/test').voice!,
      modelsDir: '',
      userModels: [],
      openAiApiKeyConfigured: false
    })
  })

  it('strips unknown nested fields and repo-scoped quick commands from imported exports', () => {
    const document = {
      ...createSettingsExportDocument(getDefaultSettings('/Users/test')),
      settings: {
        terminalColorOverrides: {
          foreground: '#ffffff',
          apiKey: 'color-secret'
        },
        terminalQuickCommands: [
          {
            id: 'global-command',
            label: 'Global command',
            scope: { type: 'global' },
            action: 'terminal-command',
            command: 'echo hi',
            appendEnter: true,
            token: 'quick-command-secret'
          },
          {
            id: 'repo-command',
            label: 'Repo command',
            scope: { type: 'repo', repoId: 'repo-id-from-another-machine' },
            action: 'terminal-command',
            command: 'npm test',
            appendEnter: true
          }
        ],
        agentCmdOverrides: {
          claude: 'claude',
          apiKey: 'agent-secret'
        },
        commitMessageAi: {
          ...getDefaultSettings('/Users/test').commitMessageAi!,
          apiKey: 'commit-secret',
          selectedModelByAgent: { claude: 'sonnet', apiKey: 'model-secret' },
          discoveredModelsByAgent: {
            claude: [{ id: 'sonnet', label: 'Sonnet', apiKey: 'nested-secret' }]
          }
        },
        sourceControlAi: {
          ...getDefaultSettings('/Users/test').sourceControlAi!,
          apiKey: 'source-secret',
          selectedModelByAgent: { claude: 'sonnet', apiKey: 'model-secret' },
          actions: {
            commitMessage: {
              agentId: 'claude',
              commandInputTemplate: '{basePrompt}',
              apiKey: 'action-secret'
            }
          }
        },
        notifications: {
          ...getDefaultSettings('/Users/test').notifications,
          customSoundId: 'custom',
          customSoundPath: '/Users/test/sounds/done.wav',
          apiKey: 'notification-secret'
        }
      }
    } as unknown as SettingsExportDocument

    const portable = getPortableSettingsFromExport(document).settings

    expect(portable.terminalColorOverrides).toEqual({ foreground: '#ffffff' })
    expect(portable.terminalQuickCommands).toEqual([
      {
        id: 'global-command',
        label: 'Global command',
        scope: { type: 'global' },
        action: 'terminal-command',
        command: 'echo hi',
        appendEnter: true
      }
    ])
    expect(portable.agentCmdOverrides).toEqual({ claude: 'claude' })
    expect(portable.commitMessageAi).not.toHaveProperty('apiKey')
    expect(portable.commitMessageAi?.selectedModelByAgent).toEqual({ claude: 'sonnet' })
    expect(portable.commitMessageAi?.discoveredModelsByAgent?.claude?.[0]).toEqual({
      id: 'sonnet',
      label: 'Sonnet'
    })
    expect(portable.sourceControlAi).not.toHaveProperty('apiKey')
    expect(portable.sourceControlAi?.selectedModelByAgent).toEqual({ claude: 'sonnet' })
    expect(portable.sourceControlAi?.actions?.commitMessage).toEqual({
      agentId: 'claude',
      commandInputTemplate: '{basePrompt}'
    })
    expect(portable.sourceControlAi?.modelOverridesByOperation).toBeUndefined()
    expect(portable.notifications).toEqual({
      ...getDefaultSettings('/Users/test').notifications,
      customSoundId: 'system',
      customSoundPath: null
    })
  })

  it('previews supported exports and reports changed and skipped settings keys', () => {
    const document = {
      ...createSettingsExportDocument(getDefaultSettings('/Users/test')),
      settings: {
        theme: 'dark',
        sourceControlViewMode: 'tree',
        workspaceDir: '/Users/test/orca/workspaces'
      },
      keybindings: { keybindings: {}, platforms: {} }
    }

    expect(
      previewSettingsExportImport(document, { theme: 'system', sourceControlViewMode: 'tree' })
    ).toEqual({
      ok: true,
      portableSettingCount: 2,
      changedSettingKeys: ['theme'],
      skippedSettingKeys: ['workspaceDir'],
      includesKeybindings: true,
      changedKeybindings: true
    })
  })

  it('does not report keybindings as changed when the portable snapshot matches', () => {
    const keybindings = {
      keybindings: { 'terminal.search': ['Ctrl+Shift+F'] },
      platforms: { darwin: {}, linux: {}, win32: {} }
    }
    const document = createSettingsExportDocument(getDefaultSettings('/Users/test'), {
      keybindings
    })

    expect(
      previewSettingsExportImport(document, getDefaultSettings('/Users/test'), {
        currentKeybindings: keybindings
      })
    ).toMatchObject({
      includesKeybindings: true,
      changedKeybindings: false
    })
  })

  it('does not report local-only or normalized fields as changes for a fresh export', () => {
    const current = {
      ...getDefaultSettings('/Users/test'),
      claudeAgentTeamsMode: 'orca-managed-tmux' as const,
      terminalQuickCommands: [
        {
          id: 'global-command',
          label: 'Global command',
          scope: { type: 'global' as const },
          action: 'terminal-command' as const,
          command: 'echo hi',
          appendEnter: true
        },
        {
          id: 'repo-command',
          label: 'Repo command',
          scope: { type: 'repo' as const, repoId: 'local-repo-id' },
          action: 'terminal-command' as const,
          command: 'npm test',
          appendEnter: true
        }
      ],
      sourceControlAi: {
        ...getDefaultSettings('/Users/test').sourceControlAi!,
        enabled: true,
        agentId: 'claude' as const,
        selectedModelByAgent: { claude: 'claude-opus-4-7' },
        selectedThinkingByModel: { 'claude-opus-4-7': 'low' }
      },
      voice: {
        ...getDefaultSettings('/Users/test').voice!,
        enabled: true,
        modelsDir: '/Users/test/models',
        userModels: [{ id: 'custom-model', type: 'whisper' as const, dir: '/Users/test/model' }],
        openAiApiKeyConfigured: true
      }
    }
    const document = createSettingsExportDocument(current)

    expect(previewSettingsExportImport(document, current)).toMatchObject({
      ok: true,
      changedSettingKeys: [],
      skippedSettingKeys: [],
      changedKeybindings: false
    })
    expect(getPortableSettingsFromExport(document, current).settings.terminalQuickCommands).toEqual(
      current.terminalQuickCommands
    )
    expect(getPortableSettingsFromExport(document, current).settings.voice).toEqual(current.voice)
  })

  it('skips portable keys with invalid value shapes', () => {
    const document = {
      ...createSettingsExportDocument(getDefaultSettings('/Users/test')),
      settings: {
        theme: 'neon',
        terminalFontSize: 'huge',
        editorAutoSave: true,
        notifications: {
          enabled: true,
          agentTaskComplete: 'yes',
          terminalBell: true,
          suppressWhenFocused: false,
          customSoundId: 'not-real',
          customSoundPath: 42,
          customSoundVolume: Number.NaN
        }
      }
    }

    expect(previewSettingsExportImport(document, {})).toMatchObject({
      ok: true,
      portableSettingCount: 1,
      changedSettingKeys: ['editorAutoSave'],
      skippedSettingKeys: ['theme', 'terminalFontSize', 'notifications']
    })
  })

  it('rejects unknown document formats', () => {
    expect(
      previewSettingsExportImport({ kind: 'other', version: 1, settings: {} }, {})
    ).toMatchObject({
      ok: false,
      error: 'This file is not a supported Orca settings export.'
    })
  })
})
