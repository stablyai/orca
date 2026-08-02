import { describe, expect, it } from 'vitest'
import {
  addClaudeTeammateModeAuto,
  isDirectClaudeCommand,
  parseTmuxArgs,
  renderTmuxFormat,
  splitTmuxCommand,
  tmuxSendKeysText,
  tmuxValue
} from './claude-agent-teams-tmux-compat'

describe('claude agent teams tmux compat primitives', () => {
  it('parses clustered tmux flags and keeps split size out of positional command text', () => {
    const parsed = parseTmuxArgs(
      ['-t', '%1', '-hPl', '70%', '-F', '#{pane_id}', 'echo hi'],
      ['-t', '-l', '-F'],
      ['-h', '-P', '-d']
    )

    expect(parsed.flags.has('-h')).toBe(true)
    expect(parsed.flags.has('-P')).toBe(true)
    expect(tmuxValue(parsed, '-l')).toBe('70%')
    expect(tmuxValue(parsed, '-F')).toBe('#{pane_id}')
    expect(parsed.positional).toEqual(['echo hi'])
  })

  it('recognizes top-level tmux version probes separately from subcommand flags', () => {
    expect(splitTmuxCommand(['-V'])).toEqual({ command: '-V', args: [] })
    expect(splitTmuxCommand(['split-window', '-v'])).toEqual({
      command: 'split-window',
      args: ['-v']
    })
  })

  it('renders supported tmux format variables and removes unknown variables', () => {
    expect(
      renderTmuxFormat(
        '#{session_name}:#{window_index}:#{missing}',
        {
          session_name: 'orca',
          window_index: '0'
        },
        'fallback'
      )
    ).toBe('orca:0:')
  })

  it('maps send-keys tokens using practical tmux semantics', () => {
    expect(tmuxSendKeysText(['hello', 'Space', 'world', 'Enter'], false)).toBe('hello world\r')
    expect(tmuxSendKeysText(['hello', 'Space', 'world'], true)).toBe('hello Space world')
  })

  it('only rewrites direct Claude launch commands', () => {
    expect(isDirectClaudeCommand("claude 'fix it'")).toBe(true)
    expect(isDirectClaudeCommand("echo ok; claude 'fix it'")).toBe(false)
    expect(addClaudeTeammateModeAuto("claude 'fix it'")).toBe(
      "claude --teammate-mode auto 'fix it'"
    )
    expect(addClaudeTeammateModeAuto('claude --teammate-mode in-process')).toBe(
      'claude --teammate-mode in-process'
    )
  })
})
