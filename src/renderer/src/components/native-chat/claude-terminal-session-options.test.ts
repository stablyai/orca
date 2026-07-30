import { describe, expect, it } from 'vitest'
import { readClaudeSessionOptionsFromTerminalScreen } from './claude-terminal-session-options'

describe('Claude terminal session option detection', () => {
  it('reads the current model and effort from Claude header chrome', () => {
    const screen =
      '\u001b[1mClaude Code\u001b[0m v2.1.211\r\n' +
      '\u001b[38;2;102;102;102mOpus 4.8 with high effort · API Usage Billing\r\n' +
      '~/Documents/projects/orca'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'opus',
      effort: 'high'
    })
  })

  it('reads a Claude header whose xterm serialization joins the version to the title', () => {
    const screen =
      '\u001b[?1049h\u001b[H▐▛███▜▌Claude Codev2.1.211\r\n' +
      '▝▜█████▛▘Sonnet 5 with medium effort · API Usage Billing'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'sonnet',
      effort: 'medium'
    })
  })

  it('does not mistake old conversation output for the current model', () => {
    const screen =
      'Set model to Opus 4.8 and saved as your default\r\n' +
      'Claude Code v2.1.211\r\n' +
      'Sonnet 5 with medium effort · API Usage Billing'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'sonnet',
      effort: 'medium'
    })
  })

  it('reports an option-less Haiku model without inventing effort', () => {
    expect(
      readClaudeSessionOptionsFromTerminalScreen(
        'Claude Code v2.1.211\r\nHaiku · API Usage Billing\r\n~/repo'
      )
    ).toEqual({ model: 'haiku' })
  })

  it('ignores text without Claude header chrome', () => {
    expect(
      readClaudeSessionOptionsFromTerminalScreen('I recommend Opus 4.8 for this task.')
    ).toBeNull()
  })
})
