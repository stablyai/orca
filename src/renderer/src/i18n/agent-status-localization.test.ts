import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const GROUPS = ['AgentHealthRows', 'AgentStatusPanel', 'AgentStatusSegment'] as const
const LOCALES = { es, ja, ko, zh }

describe('agent status localization', () => {
  it.each(Object.entries(LOCALES))('%s keeps every English agent-status key', (_, catalog) => {
    const english = en.auto.components.status.bar
    const localized = catalog.auto.components.status.bar

    for (const group of GROUPS) {
      expect(Object.keys(localized[group]).sort()).toEqual(Object.keys(english[group]).sort())
    }
  })

  it.each(Object.entries(LOCALES))(
    '%s translates representative agent-status copy',
    (_, catalog) => {
      const english = en.auto.components.status.bar
      const localized = catalog.auto.components.status.bar

      expect(localized.AgentHealthRows.updateNow).not.toBe(english.AgentHealthRows.updateNow)
      expect(localized.AgentStatusPanel.title).not.toBe(english.AgentStatusPanel.title)
      expect(localized.AgentStatusSegment.checking).not.toBe(english.AgentStatusSegment.checking)
    }
  )
})
