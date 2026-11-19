import { expect, it } from 'vitest'
import { subagentMessageText } from './native-chat-subagent-entry-detail'

it('keeps code spans literal while dropping markdown marks around them', () => {
  expect(subagentMessageText('**Done.** Read `~/.config` and `src/__tests__/*.ts`')).toBe(
    'Done. Read ~/.config and src/__tests__/*.ts'
  )
})

it('closes a code span only on an equal backtick run and leaves links inside it alone', () => {
  expect(subagentMessageText('Use ``a`b`` with `[a](b)`, see [docs](https://example.com)')).toBe(
    'Use a`b with [a](b), see docs'
  )
})
