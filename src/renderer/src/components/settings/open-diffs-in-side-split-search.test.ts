import { afterEach, describe, expect, it } from 'vitest'

import { i18n } from '@/i18n/i18n'
import { openDiffsInSideSplitMatchesSearch } from './OpenDiffsInSideSplitSetting'

const SIDE_SPLIT_KEY = 'auto.components.settings.git.search.sideSplit'

describe('openDiffsInSideSplitMatchesSearch', () => {
  // Why: i18n is shared, so restore the language and injected alias for later tests.
  const initialLanguage = i18n.language
  let hadAlias = false
  let previousAlias: unknown

  afterEach(async () => {
    if (hadAlias) {
      const zh = i18n.store.data.zh?.translation as Record<string, unknown> | undefined
      if (zh) {
        if (previousAlias === undefined) {
          delete zh[SIDE_SPLIT_KEY]
        } else {
          zh[SIDE_SPLIT_KEY] = previousAlias
        }
      }
      hadAlias = false
      previousAlias = undefined
    }
    await i18n.changeLanguage(initialLanguage)
  })

  it('matches English keywords', () => {
    expect(openDiffsInSideSplitMatchesSearch('side split')).toBe(true)
    expect(openDiffsInSideSplitMatchesSearch('diff preview')).toBe(true)
  })

  it('does not match unrelated queries', () => {
    expect(openDiffsInSideSplitMatchesSearch('branch prefix')).toBe(false)
  })

  // Why: inject the missing alias so translate() cannot pass via its English fallback.
  it('matches a localized alias once one exists for the UI locale', async () => {
    previousAlias = (i18n.store.data.zh?.translation as Record<string, unknown> | undefined)?.[
      SIDE_SPLIT_KEY
    ]
    hadAlias = true
    i18n.addResourceBundle('zh', 'translation', { [SIDE_SPLIT_KEY]: '侧边分栏' }, true, true)
    await i18n.changeLanguage('zh')

    expect(openDiffsInSideSplitMatchesSearch('侧边分栏')).toBe(true)
    // English aliases stay searchable for devs who type them regardless of UI locale.
    expect(openDiffsInSideSplitMatchesSearch('side split')).toBe(true)
  })
})
