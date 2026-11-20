import { describe, expect, it } from 'vitest'
import { commandCodePaneTitleStatus } from './command-code-terminal-title'

describe('commandCodePaneTitleStatus', () => {
  it('claims idle only for a Command Code pane under its own title with its composer idle', () => {
    expect(commandCodePaneTitleStatus('⌘ Session · deepseek', 'command-code', true)).toBe('idle')
    expect(commandCodePaneTitleStatus('█ Session · deepseek', 'command-code', true)).toBe('idle')
    expect(commandCodePaneTitleStatus('⌘ Session · deepseek', 'command-code', false)).toBeNull()
    expect(commandCodePaneTitleStatus('⌘ Session · deepseek', 'claude', true)).toBeNull()
    expect(commandCodePaneTitleStatus('⌘ Session · deepseek', null, true)).toBeNull()
    expect(commandCodePaneTitleStatus('~/repo', 'command-code', true)).toBeNull()
  })
})
