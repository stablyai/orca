import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOT_TEMPLATES } from './bot-templates'
import { BOT_TEMPLATE_SKILL_LINES } from './bot-template-view'
import { botTemplateBotName, botTemplatePartWords, botTemplateTextKeys } from './bot-template-text'

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
    // Every template subtree, so a removed or renamed template's leftover words fail too.
    for (const [id, node] of Object.entries(bots.templates ?? {})) {
      if (node && typeof node === 'object' && id !== 'category') {
        walk(node, `templates.${id}`)
      }
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

// A translator over the shipped zh catalog, as i18next resolves it: the catalog value, else the fallback.
const zh = JSON.parse(
  readFileSync(join(process.cwd(), 'src/renderer/src/i18n/locales/zh.json'), 'utf8')
)
const tZh = (key: string, fallback: string, values: Record<string, unknown> = {}): string => {
  const found = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], zh)
  const text = typeof found === 'string' ? found : fallback
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match
  )
}
const standup = BOT_TEMPLATES.find((template) => template.id === 'standup')!

describe('a template in Chinese', () => {
  it('names the new bot in Chinese, free among the bots already there', () => {
    expect(botTemplateBotName(standup, [], tZh)).toBe(zh.bots.templates.standup.name)
    expect(botTemplateBotName(standup, [zh.bots.templates.standup.name], tZh)).toBe(
      `${zh.bots.templates.standup.name} 2`
    )
  })

  it('lists its skills, automations and schedules in Chinese', () => {
    const template = BOT_TEMPLATES.find((entry) => entry.id === 'pr-review')!
    const words = botTemplatePartWords(template, tZh)
    const own = zh.bots.templates['pr-review']
    expect(words.skills).toEqual([
      {
        skill: 'pr-review-checklist',
        name: `${zh.bots.templateSkills.prReviewChecklist}（pr-review-checklist）`,
        line: zh.bots.templateSkills.lines['pr-review-checklist']
      }
    ])
    expect(words.events).toEqual([
      {
        id: 'review-requested',
        trigger: own.events['review-requested'].trigger,
        action: own.events['review-requested'].action
      }
    ])
    expect(botTemplatePartWords(standup, tZh).schedules).toEqual(
      standup.schedules.map((schedule) => ({
        id: schedule.id,
        when: zh.bots.templates.standup.schedules[schedule.id].when,
        what: zh.bots.templates.standup.schedules[schedule.id].what
      }))
    )
  })
})
