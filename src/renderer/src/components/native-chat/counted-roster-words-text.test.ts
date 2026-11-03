import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { sayBackgroundTaskTranslated } from './background-task-words-text'
import { sayNativeChatSubagentGroupTranslated } from './native-chat-subagent-group-words-text'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

it('picks each Russian plural form for counted roster phrases', async () => {
  await i18n.changeLanguage('ru')
  const counts = [1, 3, 5, 21]
  expect(counts.map((count) => sayBackgroundTaskTranslated('countAgents', { count }))).toEqual([
    '1 агент',
    '3 агента',
    '5 агентов',
    '21 агент'
  ])
  expect(counts.map((count) => sayNativeChatSubagentGroupTranslated('ran', { count }))).toEqual([
    'Работал 1 дочерний агент',
    'Работали 3 дочерних агента',
    'Работали 5 дочерних агентов',
    'Работал 21 дочерний агент'
  ])
})
