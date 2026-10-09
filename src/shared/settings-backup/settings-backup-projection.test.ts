import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../constants'
import type { GlobalSettings } from '../global-settings-types'
import {
  DEFAULT_SETTINGS_BACKUP_SECTIONS,
  SETTINGS_BACKUP_KEY_CLASSES,
  SETTINGS_BACKUP_SECTIONS,
  getSettingsBackupKeyClass,
  listSettingsBackupKeys
} from './settings-backup-catalog'
import {
  buildSettingsBackupUpdate,
  defaultSelectedSettingsBackupKeys,
  diffSettingsBackup,
  projectSettingsForBackup
} from './settings-backup-projection'
import { containsSecretLikeValue } from './settings-backup-secret-scan'

function settingsWith(overrides: Partial<GlobalSettings>): GlobalSettings {
  return { ...getDefaultSettings('/home/tester'), ...overrides }
}

describe('settings backup catalog', () => {
  it('classifies every default setting', () => {
    for (const key of Object.keys(getDefaultSettings('/home/tester'))) {
      expect(getSettingsBackupKeyClass(key), key).not.toBeNull()
    }
  })

  it('keeps credentials, accounts and grants out of every exportable section', () => {
    const exportable = new Set(listSettingsBackupKeys(SETTINGS_BACKUP_SECTIONS))
    for (const key of [
      'opencodeSessionCookie',
      'httpProxyUrl',
      'agentDefaultEnv',
      'codexManagedAccounts',
      'claudeManagedAccounts',
      'pluginConsents',
      'artifactSharingEnabled',
      'floatingTerminalTrustedCwds',
      'telemetry',
      'machineName'
    ] as const) {
      expect(exportable.has(key), key).toBe(false)
    }
  })

  it('leaves device settings out by default', () => {
    expect(DEFAULT_SETTINGS_BACKUP_SECTIONS).not.toContain('device')
    expect(SETTINGS_BACKUP_KEY_CLASSES.workspaceDir).toBe('device')
  })
})

describe('projectSettingsForBackup', () => {
  it('exports only the chosen sections', () => {
    const { settings } = projectSettingsForBackup(settingsWith({ theme: 'dark' }), ['appearance'])
    expect(settings.theme).toBe('dark')
    expect(settings.terminalFontSize).toBeUndefined()
    expect(settings.workspaceDir).toBeUndefined()
  })

  it('never exports protected values even when every section is chosen', () => {
    const { settings } = projectSettingsForBackup(
      settingsWith({ opencodeSessionCookie: 'session=abc', httpProxyUrl: 'http://u:p@proxy:8080' }),
      SETTINGS_BACKUP_SECTIONS
    )
    expect(settings.opencodeSessionCookie).toBeUndefined()
    expect(settings.httpProxyUrl).toBeUndefined()
    expect(JSON.stringify(settings)).not.toContain('session=abc')
  })

  it('drops free-form values that look like credentials', () => {
    const token = `ghp_${'a'.repeat(36)}`
    const { settings, excludedSecretKeys } = projectSettingsForBackup(
      settingsWith({ agentDefaultArgs: { claude: `--token ${token}` } }),
      ['agents']
    )
    expect(settings.agentDefaultArgs).toBeUndefined()
    expect(excludedSecretKeys).toEqual(['agentDefaultArgs'])
  })

  it('strips machine-bound notification fields', () => {
    const current = settingsWith({})
    const { settings } = projectSettingsForBackup(
      settingsWith({
        notifications: { ...current.notifications, customSoundPath: '/home/tester/ding.wav' }
      }),
      ['notifications']
    )
    expect(settings.notifications).toBeDefined()
    expect(settings.notifications).not.toHaveProperty('customSoundPath')
  })
})

describe('diffSettingsBackup', () => {
  const base = { sourcePlatform: 'darwin' as const, currentPlatform: 'darwin' as const }

  it('reports changed keys and counts unchanged ones', () => {
    const current = settingsWith({ theme: 'light' })
    const diff = diffSettingsBackup({
      ...base,
      current,
      incoming: { theme: 'dark', terminalFontSize: current.terminalFontSize }
    })
    expect(diff.unchangedKeyCount).toBe(1)
    expect(diff.entries).toEqual([
      expect.objectContaining({ key: 'theme', currentValue: 'light', incomingValue: 'dark' })
    ])
    expect(defaultSelectedSettingsBackupKeys(diff.entries)).toEqual(['theme'])
  })

  it('blocks protected, unknown, malformed and secret-like values', () => {
    const diff = diffSettingsBackup({
      ...base,
      current: settingsWith({}),
      incoming: {
        opencodeSessionCookie: 'stolen',
        someFutureSetting: true,
        terminalFontSize: 'huge',
        branchPrefixCustom: `sk-${'x'.repeat(40)}`
      }
    })
    const reasons = Object.fromEntries(diff.entries.map((entry) => [entry.key, entry.skipReason]))
    expect(reasons).toEqual({
      opencodeSessionCookie: 'protected-key',
      someFutureSetting: 'unsupported-key',
      terminalFontSize: 'invalid-value',
      branchPrefixCustom: 'secret-like-value'
    })
    expect(diff.entries.every((entry) => !entry.applicable)).toBe(true)
    // Blocked entries must not echo values from the file.
    expect(diff.entries.every((entry) => entry.incomingValue === undefined)).toBe(true)
  })

  it('asks for opt-in before applying device settings from another OS', () => {
    const diff = diffSettingsBackup({
      sourcePlatform: 'win32',
      currentPlatform: 'darwin',
      current: settingsWith({}),
      incoming: { terminalWindowsShell: 'pwsh.exe' }
    })
    expect(diff.entries[0]).toMatchObject({ skipReason: 'other-platform', applicable: true })
    expect(defaultSelectedSettingsBackupKeys(diff.entries)).toEqual([])
  })

  it('keeps the local notification sound path on import', () => {
    const current = settingsWith({})
    current.notifications = { ...current.notifications, customSoundPath: '/local/ding.wav' }
    const diff = diffSettingsBackup({
      ...base,
      current,
      incoming: {
        notifications: { ...current.notifications, customSoundPath: null, enabled: false }
      }
    })
    expect(diff.entries[0].incomingValue).toMatchObject({
      enabled: false,
      customSoundPath: '/local/ding.wav'
    })
  })
})

describe('buildSettingsBackupUpdate', () => {
  it('applies only selected, applicable entries', () => {
    const diff = diffSettingsBackup({
      sourcePlatform: 'linux',
      currentPlatform: 'linux',
      current: settingsWith({ theme: 'light', diffWordWrap: false }),
      incoming: { theme: 'dark', diffWordWrap: true, pluginConsents: { evil: 'x' } }
    })
    const update = buildSettingsBackupUpdate(diff.entries, ['theme', 'pluginConsents'])
    expect(update).toEqual({ theme: 'dark' })
  })
})

describe('containsSecretLikeValue', () => {
  it('flags common token shapes and URL credentials', () => {
    expect(containsSecretLikeValue('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true)
    expect(containsSecretLikeValue(['AKIAABCDEFGHIJKLMNOP'])).toBe(true)
    expect(containsSecretLikeValue({ url: 'https://me:hunter2@example.com' })).toBe(true)
    expect(containsSecretLikeValue({ apiKey: 'anything' })).toBe(true)
  })

  it('leaves ordinary preferences alone', () => {
    expect(containsSecretLikeValue('Ghostty Default Style Dark')).toBe(false)
    expect(containsSecretLikeValue({ command: 'npm run dev', label: 'Dev' })).toBe(false)
  })
})
