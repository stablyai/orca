import { beforeEach, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_SPANISH, UI_LANGUAGE_ENGLISH } from '../../../../shared/ui-language'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-status-defaults'
import { getLocalizedWorkspaceStatusLabel } from './workspace-status-copy'

describe('workspace-status-copy', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('returns the English fallback label for each default status', () => {
    expect(getLocalizedWorkspaceStatusLabel(DEFAULT_WORKSPACE_STATUSES[0])).toBe('Todo')
    expect(getLocalizedWorkspaceStatusLabel(DEFAULT_WORKSPACE_STATUSES[1])).toBe('In progress')
    expect(getLocalizedWorkspaceStatusLabel(DEFAULT_WORKSPACE_STATUSES[2])).toBe('In review')
    expect(getLocalizedWorkspaceStatusLabel(DEFAULT_WORKSPACE_STATUSES[3])).toBe('Done')
  })

  it('leaves a user-customized label untouched even when the id matches a default status', () => {
    const customized = { ...DEFAULT_WORKSPACE_STATUSES[1], label: 'Doing' }
    expect(getLocalizedWorkspaceStatusLabel(customized)).toBe('Doing')
  })

  it('falls back to the given label for a non-default status id', () => {
    const custom = { id: 'blocked', label: 'Blocked', color: 'neutral', icon: 'circle' }
    expect(getLocalizedWorkspaceStatusLabel(custom)).toBe('Blocked')
  })

  it('translates the default label when switching the renderer UI language', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(getLocalizedWorkspaceStatusLabel(DEFAULT_WORKSPACE_STATUSES[0])).not.toBe('Todo')
    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
  })
})
