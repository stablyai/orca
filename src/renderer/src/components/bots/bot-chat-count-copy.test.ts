import { afterEach, describe, expect, it } from 'vitest'
import { i18n, translate } from '@/i18n/i18n'
import { DEFAULT_LOCALE } from '@/i18n/supported-languages'
import { botChatMoreMatchesNote } from '../../../../shared/bots/bot-chat-tree-view'
import { botSidebarWorkerPagingLabel } from '../../../../shared/bots/bot-sidebar-tree'

const NOTE = 'Search for more of a name to narrow it.'

afterEach(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

// No catalog translates these yet, so every locale shows English with English's plural rule.
describe.each(['en', 'ja', 'ru'])('bot chat count copy in %s', (locale) => {
  it('names one worker or match in the singular and more in the plural', async () => {
    await i18n.changeLanguage(locale)
    const workers = (count: number) =>
      botSidebarWorkerPagingLabel(translate, { remaining: count, label: 'count' })
    const matches = (count: number) => botChatMoreMatchesNote(translate, count)

    expect([1, 2, 21].map(workers)).toEqual([
      'Show 1 more worker',
      'Show 2 more workers',
      'Show 21 more workers'
    ])
    expect([1, 2, 21].map(matches)).toEqual([
      `1 more match. ${NOTE}`,
      `2 more matches. ${NOTE}`,
      `21 more matches. ${NOTE}`
    ])
  })
})
