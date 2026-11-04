import { afterEach, describe, expect, it } from 'vitest'
import { i18n, translate } from '@/i18n/i18n'
import { buildShortcutDefinitionCatalog } from './shortcut-definition-catalog'
import { getShortcutsPaneSearchEntries } from './shortcuts-search'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('move-to-split shortcut localization', () => {
  it.each([
    ['es', 'Mover pestaña a división: Derecha'],
    ['fr', "Déplacer l'onglet vers la scission: Droite"],
    ['ja', 'タブを分割へ移動: 右'],
    ['ko', '탭을 분할로 이동: 오른쪽'],
    ['zh', '将标签页移至拆分: 右']
  ])('shares the localized %s title between shortcut rows and search', async (locale, expected) => {
    await i18n.changeLanguage(locale)

    const catalog = buildShortcutDefinitionCatalog({
      disabledTuiAgents: [],
      pluginCommands: [],
      keybindings: {},
      platform: 'darwin',
      missionControlConflictMessage: translate(
        'auto.components.settings.shortcutDefinitionCatalog.missionControlConflict',
        'Blocked by Mission Control. Remap here or change it in System Settings.'
      )
    })
    const rowTitle = catalog.definitionsByAction.get('tab.moveToSplitRight')?.title
    const searchTitle = getShortcutsPaneSearchEntries().find(
      (entry) => entry.title === rowTitle
    )?.title

    expect(rowTitle).toBe(expected)
    expect(searchTitle).toBe(rowTitle)
  })
})
