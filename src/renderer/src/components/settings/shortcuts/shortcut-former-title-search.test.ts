import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import ja from '@/i18n/locales/ja.json'
import { groupDefinitions } from './shortcut-groups'
import { matchesShortcutLocalSearch, normalizeShortcutLocalSearchQuery } from './ShortcutFilterRail'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

it('finds the renamed palette row by its former localized title', async () => {
  i18n.addResourceBundle('ja', 'translation', ja)
  await i18n.changeLanguage('ja')
  const query = normalizeShortcutLocalSearchQuery('ワークツリーを切り替え') ?? ''

  const matchingIds = groupDefinitions([])
    .flatMap((group) => group.items.map((item) => ({ item, groupTitle: group.title })))
    .filter((row) =>
      matchesShortcutLocalSearch(
        { ...row, effective: [], modified: false, warnings: [] },
        query,
        'darwin'
      )
    )
    .map((row) => row.item.id)

  expect(matchingIds).toContain('worktree.palette')
})
