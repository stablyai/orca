import { expect, it } from 'vitest'
import { tmuxSendKeysText } from './claude-agent-teams-tmux-compat'

it('sends consecutive key arguments without inserting spaces', () => {
  expect(tmuxSendKeysText(['hello', ' world', 'Enter'], false)).toBe('hello world\r')
  expect(tmuxSendKeysText(['a', 'b', 'Enter'], true)).toBe('abEnter')
})
