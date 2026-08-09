import { describe, expect, it } from 'vitest'
import { normalizeSettingsUpdates } from './settings'
import type { GlobalSettings, OpenWithApplication } from '../../../../shared/types'

const preview: OpenWithApplication = {
  id: 'app-preview',
  label: 'Preview',
  command: `open -a '/Applications/Preview.app'`,
  applicationPath: '/Applications/Preview.app'
}

function settingsWith(overrides: Partial<GlobalSettings>): GlobalSettings {
  return {
    openWithApplications: [preview],
    openWithDefaults: {},
    ...overrides
  } as GlobalSettings
}

describe('normalizeSettingsUpdates for Open With', () => {
  it('keeps a defaults-only update pointing at the stored applications', () => {
    const result = normalizeSettingsUpdates(
      { openWithDefaults: { '.png': 'app-preview' } },
      settingsWith({})
    )

    expect(result.openWithDefaults).toEqual({ '.png': 'app-preview' })
    expect(result).not.toHaveProperty('openWithApplications')
  })

  it('keeps stored rules when only the application list is updated', () => {
    const result = normalizeSettingsUpdates(
      { openWithApplications: [preview] },
      settingsWith({ openWithDefaults: { '.png': 'app-preview' } })
    )

    expect(result.openWithApplications).toEqual([preview])
    expect(result).not.toHaveProperty('openWithDefaults')
  })

  it('drops a rule whose application is removed in the same update', () => {
    const result = normalizeSettingsUpdates(
      { openWithApplications: [], openWithDefaults: { '.png': 'app-preview' } },
      settingsWith({ openWithDefaults: { '.png': 'app-preview' } })
    )

    expect(result.openWithApplications).toEqual([])
    expect(result.openWithDefaults).toEqual({})
  })

  it('accepts an adopted Open in editor that has no bundle path', () => {
    const vscode: OpenWithApplication = {
      id: 'vscode',
      label: 'VS Code',
      command: 'code',
      applicationPath: ''
    }

    const result = normalizeSettingsUpdates(
      {
        openWithApplications: [preview, vscode],
        openWithDefaults: { '.ts': 'vscode' }
      },
      settingsWith({})
    )

    expect(result.openWithApplications).toEqual([preview, vscode])
    expect(result.openWithDefaults).toEqual({ '.ts': 'vscode' })
  })
})
