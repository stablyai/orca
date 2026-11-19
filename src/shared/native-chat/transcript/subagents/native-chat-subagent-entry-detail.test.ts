import { expect, it } from 'vitest'
import { subagentMessageText } from './native-chat-subagent-entry-detail'

it('keeps code spans literal while dropping markdown marks around them', () => {
  expect(subagentMessageText('**Done.** Read `~/.config` and `src/__tests__/*.ts`')).toBe(
    'Done. Read ~/.config and src/__tests__/*.ts'
  )
})
