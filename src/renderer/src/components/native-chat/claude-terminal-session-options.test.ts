import { describe, expect, it } from 'vitest'
import { readClaudeSessionOptionsFromTerminalScreen } from './claude-terminal-session-options'

describe('Claude terminal session option detection', () => {
  it('reads the current model and effort from Claude header chrome', () => {
    const screen =
      '\u001b[1mClaude Code\u001b[0m v2.1.211\r\n' +
      '\u001b[38;2;102;102;102mOpus 5 with high effort · API Usage Billing\r\n' +
      '~/Documents/projects/orca'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'opus',
      context1m: false,
      effort: 'high'
    })
  })

  it('distinguishes the 1M-context Opus header from plain Opus', () => {
    const screen =
      '\u001b[1mClaude Code\u001b[0m v2.1.220\r\n' +
      '\u001b[38;2;102;102;102mOpus 5 (1M context) with high effort · Claude Max\r\n' +
      '~/Documents/projects/orca'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'opus',
      context1m: true,
      effort: 'high'
    })
  })

  it('reads a previous-generation model that only the full id can select', () => {
    const screen =
      '\u001b[1mClaude Code\u001b[0m v2.1.220\r\n' +
      'Opus 4.6 with medium effort · Claude Max\r\n' +
      '~/Documents/projects/orca'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'claude-opus-4-6',
      context1m: false,
      effort: 'medium'
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
      'Set model to Opus 5 and saved as your default\r\n' +
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
      readClaudeSessionOptionsFromTerminalScreen('I recommend Opus 5 for this task.')
    ).toBeNull()
  })
})
