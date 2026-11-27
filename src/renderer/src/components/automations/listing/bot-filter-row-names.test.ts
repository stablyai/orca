import { afterEach, expect, it } from 'vitest'
import { i18n, translate } from '@/i18n/i18n'
import shippedJa from '@/i18n/locales/ja.json'
import { botFilterRowNames } from './bot-filter-row-names'

const ACTION = 'botFilterRowRemoveLabel'
const previousLanguage = i18n.language
const previousJa = i18n.getResourceBundle('ja', 'translation')

afterEach(async () => {
  i18n.removeResourceBundle('ja', 'translation')
  if (previousJa) {
    i18n.addResourceBundle('ja', 'translation', previousJa)
  }
  await i18n.changeLanguage(previousLanguage)
})

/** The shipped Japanese pack with this menu's entries edited, as a partly translated pack ships. */
async function loadJa(edit: (menu: Record<string, string>) => void): Promise<void> {
  const pack = structuredClone(shippedJa)
  edit(pack.auto.components.automations.AutomationListFilterMenu)
  i18n.addResourceBundle('ja', 'translation', pack)
  await i18n.changeLanguage('ja')
}

// Label in Name (WCAG 2.5.3): whichever half falls back to English, the name holds the visible label.
it('names the Bot row with its visible label when only the label is translated', async () => {
  await loadJa((menu) => {
    delete menu[ACTION]
  })
  const { label, accessibleName } = botFilterRowNames(translate, 'CoS')
  expect(label).not.toBe('Bot: CoS')
  expect(accessibleName).toContain(label)
})

it('names the Bot row with its visible label when only the action is translated', async () => {
  await loadJa((menu) => {
    delete menu.bot
    menu[ACTION] = 'REMOVE {{label}}'
  })
  const { label, accessibleName } = botFilterRowNames(translate, 'CoS')
  expect(label).toBe('Bot: CoS')
  expect(accessibleName).toBe('REMOVE Bot: CoS')
})
