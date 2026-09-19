import { afterAll, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { matchesSettingsSearch } from './settings-search'
import { getTerminalShellHistorySearchEntry } from './terminal-shell-history-search'

const LOCALIZED_HISTORY = [
  ['es', 'Limitar el historial del shell a cada espacio de trabajo'],
  ['ja', 'ワークスペースごとにシェル履歴を分離'],
  ['ko', '워크스페이스별로 셸 기록 분리'],
  ['zh', '按工作区隔离 Shell 历史记录']
] as const

describe('terminal shell history localization', () => {
  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it.each(LOCALIZED_HISTORY)('localizes the control in %s', async (locale, controlTitle) => {
    await i18n.changeLanguage(locale)

    expect(getTerminalShellHistorySearchEntry().title).toBe(controlTitle)
  })

  it.each([
    ['es', 'búsqueda inversa'],
    ['ja', '自動候補'],
    ['ko', '역방향 검색'],
    ['zh', '历史记录']
  ])('finds the control with a localized %s query', async (locale, query) => {
    await i18n.changeLanguage(locale)

    expect(matchesSettingsSearch(query, getTerminalShellHistorySearchEntry())).toBe(true)
  })

  it.each(['es', 'ja', 'ko', 'zh'])('keeps technical and English aliases in %s', async (locale) => {
    await i18n.changeLanguage(locale)

    expect(getTerminalShellHistorySearchEntry().keywords).toEqual(
      expect.arrayContaining(['history', 'workspace', 'Ctrl+R', 'HISTFILE', 'zsh', 'bash', 'fish'])
    )
  })
})
