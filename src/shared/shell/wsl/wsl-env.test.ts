import { expect, it } from 'vitest'
import { addWslEnvKeys } from './wsl-env'

it('keeps an existing entry when the same variable is requested with a flag', () => {
  const env = { WSLENV: 'KITTY_WINDOW_ID:CLAUDE_CONFIG_DIR/p' }
  addWslEnvKeys(env, ['KITTY_WINDOW_ID/u', 'CLAUDE_CONFIG_DIR/u'])

  expect(env.WSLENV).toBe('KITTY_WINDOW_ID:CLAUDE_CONFIG_DIR/p')
})
