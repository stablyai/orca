import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOT_TEMPLATES } from './bot-templates'
import { BOT_TEMPLATE_SKILL_LINES } from './bot-template-view'
import { botTemplateTextKeys } from './bot-template-text'

// Why: en.json's value is what English renders, so a template edit must land in both catalogs too.
describe('template words in the English catalogs', () => {
  const expected = Object.fromEntries([
    ...BOT_TEMPLATES.flatMap(botTemplateTextKeys).map(([key, english]) => [
      `templates.${key}`,
      english
    ]),
    ...Object.entries(BOT_TEMPLATE_SKILL_LINES).map(([skill, english]) => [
      `templateSkills.lines.${skill}`,
      english
    ])
  ])
  const ids = new Set(BOT_TEMPLATES.map((template) => template.id))

  const catalogWords = (catalog: string): Record<string, string> => {
    const bots = JSON.parse(readFileSync(join(process.cwd(), catalog), 'utf8')).bots
    const words: Record<string, string> = {}
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        words[path] = node
      } else if (node && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) {
          walk(child, `${path}.${key}`)
        }
      }
    }
    for (const id of ids) {
      walk(bots.templates?.[id], `templates.${id}`)
    }
    walk(bots.templateSkills?.lines, 'templateSkills.lines')
    return words
  }

  it.each(['src/renderer/src/i18n/locales/en.json', 'mobile/src/i18n/locales/en.json'])(
    '%s holds exactly the templates’ English',
    (catalog) => {
      expect(catalogWords(catalog)).toEqual(expected)
    }
  )
})
