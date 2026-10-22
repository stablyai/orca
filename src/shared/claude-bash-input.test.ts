import { describe, expect, it } from 'vitest'
import { claudeBashInputAsTypedCommand } from './claude-bash-input'

describe('claudeBashInputAsTypedCommand', () => {
  it('restores the line as typed, keeping the space after `!`', () => {
    expect(claudeBashInputAsTypedCommand('<bash-input> gcloud auth login</bash-input>')).toBe(
      '! gcloud auth login'
    )
    expect(claudeBashInputAsTypedCommand('<bash-input>ls -la</bash-input>')).toBe('!ls -la')
  })
  it.each([
    'run <bash-input>ls</bash-input>',
    '<bash-input>ls</bash-input> and more',
    '<bash-stdout>ok</bash-stdout>',
    '<bash-input>a</bash-input><bash-input>b</bash-input>'
  ])('leaves anything else alone (%s)', (text) => {
    expect(claudeBashInputAsTypedCommand(text)).toBeNull()
  })
})
