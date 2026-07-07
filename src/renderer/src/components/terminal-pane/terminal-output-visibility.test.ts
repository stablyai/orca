import { describe, expect, it } from 'vitest'

import {
  hasTerminalDisplayContent,
  trimIncompleteTerminalControlTail
} from './terminal-output-visibility'

describe('hasTerminalDisplayContent', () => {
  it('treats title and agent-status OSC frames as metadata-only', () => {
    expect(hasTerminalDisplayContent('\x1b]0;Restored title\x07')).toBe(false)
    expect(hasTerminalDisplayContent('\x1b]9999;{"state":"working","agentType":"codex"}\x07')).toBe(
      false
    )
  })

  it('treats unterminated metadata/control frames as metadata-only', () => {
    expect(hasTerminalDisplayContent('\x1b]0;partial title')).toBe(false)
    expect(hasTerminalDisplayContent('\x1b]9999;{"state":"working"')).toBe(false)
    expect(hasTerminalDisplayContent('\x1b[31')).toBe(false)
  })

  it('treats styling-only control sequences as metadata-only', () => {
    expect(hasTerminalDisplayContent('\x1b[31m\x1b[0m')).toBe(false)
    expect(hasTerminalDisplayContent('\x1b[0 q\x1b[?25h')).toBe(false)
  })

  it('treats printable text and whitespace redraws as display content', () => {
    expect(hasTerminalDisplayContent('hello')).toBe(true)
    expect(hasTerminalDisplayContent('   ')).toBe(true)
    expect(hasTerminalDisplayContent('\r   ')).toBe(true)
    expect(hasTerminalDisplayContent('\n')).toBe(true)
  })

  it('treats erase and alternate-screen sequences as display-affecting', () => {
    expect(hasTerminalDisplayContent('\x1b[2J\x1b[H')).toBe(true)
    expect(hasTerminalDisplayContent('\x1b[?1049h')).toBe(true)
    expect(hasTerminalDisplayContent('\x1b#8')).toBe(true)
  })
})

describe('trimIncompleteTerminalControlTail', () => {
  it('drops trailing partial control frames before replay', () => {
    expect(trimIncompleteTerminalControlTail('\x1b]0;partial title')).toBe('')
    expect(trimIncompleteTerminalControlTail('visible\x1b]0;partial title')).toBe('visible')
    expect(trimIncompleteTerminalControlTail('visible\x1b[31')).toBe('visible')
  })

  it('keeps complete metadata and display frames intact', () => {
    expect(trimIncompleteTerminalControlTail('\x1b]0;Restored title\x07')).toBe(
      '\x1b]0;Restored title\x07'
    )
    expect(trimIncompleteTerminalControlTail('\x1b[31mvisible')).toBe('\x1b[31mvisible')
  })
})
