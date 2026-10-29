import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { nativeChatToolRunSentence } from './native-chat-tool-run-label'

const blocks: NativeChatBlock[] = [
  { type: 'tool-call', name: 'read', input: {} },
  { type: 'tool-call', name: 'Bash', input: { command: 'orca snapshot --page p1' } }
]

afterEach(async () => {
  await i18n.changeLanguage('en')
})

it('lowercases later English clauses but keeps German nouns capitalized', async () => {
  expect(nativeChatToolRunSentence(blocks)).toBe('Read 1 file and used the browser')
  await i18n.changeLanguage('de')
  expect(nativeChatToolRunSentence(blocks)).toBe('1 Datei gelesen und Browser verwendet')
})
