import { beforeEach, describe, expect, it } from 'vitest'

import { i18n } from '@/i18n/i18n'
import {
  getGitHubModeButtons,
  getGitHubTaskKindPresets,
  getLinearPriorityLabel
} from './task-page-localized-options'

describe('task-page-localized-options', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('refreshes GitHub task labels when the UI language changes', async () => {
    expect(getGitHubTaskKindPresets('issues').map((preset) => preset.label)).toEqual([
      'Open',
      'Assigned to me'
    ])
    expect(getGitHubModeButtons().map((button) => button.label)).toEqual([
      'Issues',
      'PRs',
      'Projects'
    ])

    await i18n.changeLanguage('ko')

    expect(getGitHubTaskKindPresets('issues').map((preset) => preset.label)).toEqual([
      '열기',
      '나에게 할당됨'
    ])
    expect(getGitHubModeButtons().map((button) => button.label)).toEqual(['이슈', 'PR', '프로젝트'])

    await i18n.changeLanguage('en')

    expect(getGitHubTaskKindPresets('issues').map((preset) => preset.label)).toEqual([
      'Open',
      'Assigned to me'
    ])
    expect(getGitHubModeButtons().map((button) => button.label)).toEqual([
      'Issues',
      'PRs',
      'Projects'
    ])
  })

  it('refreshes Linear priority labels when the UI language changes', async () => {
    expect(getLinearPriorityLabel(0)).toBe('No priority')

    await i18n.changeLanguage('ko')

    expect(getLinearPriorityLabel(0)).toBe('우선순위 없음')

    await i18n.changeLanguage('en')

    expect(getLinearPriorityLabel(0)).toBe('No priority')
  })
})
