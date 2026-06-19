import { beforeEach, describe, expect, it } from 'vitest'

import { i18n } from '@/i18n/i18n'
import { getMrStateFilters, getSmartWorkspaceNameModes } from './smart-workspace-localized-options'

describe('smart-workspace-localized-options', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('refreshes create-workspace source tabs when the UI language changes', async () => {
    expect(getSmartWorkspaceNameModes().map((mode) => mode.label)).toEqual([
      'Smart',
      'GitHub',
      'Linear',
      'GitLab',
      'Branch',
      'Name'
    ])

    await i18n.changeLanguage('zh')

    expect(getSmartWorkspaceNameModes().map((mode) => mode.label)).toEqual([
      '智能',
      'GitHub',
      'Linear',
      'GitLab',
      '分支',
      '姓名'
    ])

    await i18n.changeLanguage('en')

    expect(getSmartWorkspaceNameModes().map((mode) => mode.label)).toEqual([
      'Smart',
      'GitHub',
      'Linear',
      'GitLab',
      'Branch',
      'Name'
    ])
  })

  it('refreshes GitLab state filters when the UI language changes', async () => {
    expect(getMrStateFilters().map((filter) => filter.label)).toEqual([
      'Open',
      'Merged',
      'Closed',
      'All'
    ])

    await i18n.changeLanguage('zh')

    expect(getMrStateFilters().map((filter) => filter.label)).toEqual([
      '进行中',
      '合并',
      '已关闭',
      '全部'
    ])
  })
})
