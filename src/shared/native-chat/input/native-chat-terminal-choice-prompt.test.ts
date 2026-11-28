import { describe, expect, it } from 'vitest'
import { parseTerminalChoicePrompt } from './native-chat-terminal-choice-prompt'

const AUTO_MODE_CONFIRMATION = [
  'Bash command',
  '  Recreate the storage class via helm',
  '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
  ' │ helm upgrade --install csi csi/csi --wait',
  '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
  ' │ Auto mode needs your confirmation for this command.',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for: cd *",
  '  3. No',
  '',
  'Esc to cancel · Tab to amend'
].join('\n')

describe('parseTerminalChoicePrompt', () => {
  it('reads a confirmation the agent asks without a permission hook', () => {
    const card = parseTerminalChoicePrompt(AUTO_MODE_CONFIRMATION)
    expect(card?.title).toBe('Do you want to proceed?')
    expect(card?.options).toEqual([
      { label: 'Yes', send: '1' },
      { label: "Yes, and don't ask again for: cd *", send: '2' },
      { label: 'No', send: '3' }
    ])
    expect(card?.detail).toContain('helm upgrade --install csi csi/csi --wait')
    expect(card?.detail).toContain('Auto mode needs your confirmation for this command.')
  })

  it('reads the menu through the color escapes of the serialized screen', () => {
    const colored = AUTO_MODE_CONFIRMATION.replace(
      '❯ 1. Yes',
      '\u001b[36m❯ 1. Yes\u001b[39m'
    ).replace('Esc to cancel', '\u001b[2mEsc to cancel')
    expect(parseTerminalChoicePrompt(colored)?.options).toHaveLength(3)
  })

  it('ignores a numbered list in prose that asks nothing', () => {
    expect(parseTerminalChoicePrompt('Steps:\n1. Build\n2. Test')).toBeNull()
  })

  it('ignores a menu-like list a tool printed above the live screen bottom', () => {
    const printed = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n\n$ echo done\ndone'
    expect(parseTerminalChoicePrompt(printed)).toBeNull()
  })
})
