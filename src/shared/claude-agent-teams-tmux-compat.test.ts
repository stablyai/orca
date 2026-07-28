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

  it('maps cursor and navigation keys to their terminal sequences', () => {
    // Why: unmapped key names fall through as literal text, so `send-keys Left`
    // used to type "Left" into the pane instead of moving the cursor.
    expect(tmuxSendKeysText(['Up'], false)).toBe('\x1b[A')
    expect(tmuxSendKeysText(['Down'], false)).toBe('\x1b[B')
    expect(tmuxSendKeysText(['Right'], false)).toBe('\x1b[C')
    expect(tmuxSendKeysText(['Left'], false)).toBe('\x1b[D')
    expect(tmuxSendKeysText(['Home'], false)).toBe('\x1b[H')
    expect(tmuxSendKeysText(['End'], false)).toBe('\x1b[F')
    expect(tmuxSendKeysText(['PPage'], false)).toBe('\x1b[5~')
    expect(tmuxSendKeysText(['NPage'], false)).toBe('\x1b[6~')
    expect(tmuxSendKeysText(['IC'], false)).toBe('\x1b[2~')
    expect(tmuxSendKeysText(['DC'], false)).toBe('\x1b[3~')
    expect(tmuxSendKeysText(['BTab'], false)).toBe('\x1b[Z')
  })

  it('accepts the common aliases tmux allows for navigation keys', () => {
    expect(tmuxSendKeysText(['PageUp'], false)).toBe('\x1b[5~')
    expect(tmuxSendKeysText(['PageDown'], false)).toBe('\x1b[6~')
    expect(tmuxSendKeysText(['Insert'], false)).toBe('\x1b[2~')
    expect(tmuxSendKeysText(['Delete'], false)).toBe('\x1b[3~')
  })

  it('maps any C-<letter> chord to its control character', () => {
    expect(tmuxSendKeysText(['C-a'], false)).toBe('\x01')
    expect(tmuxSendKeysText(['C-e'], false)).toBe('\x05')
    expect(tmuxSendKeysText(['C-u'], false)).toBe('\x15')
    // Existing behavior must not regress.
    expect(tmuxSendKeysText(['C-c'], false)).toBe('\x03')
    expect(tmuxSendKeysText(['C-m'], false)).toBe('\r')
    expect(tmuxSendKeysText(['C-i'], false)).toBe('\t')
  })

  it('still treats key names as literal text under -l', () => {
    expect(tmuxSendKeysText(['Left', 'Up'], true)).toBe('Left Up')
  })

  it('keeps unknown key names as literal text', () => {
    // Why: tmux passes through anything it does not recognize; swallowing it
    // would silently drop teammate prompt words like "Home" mid-sentence.
    expect(tmuxSendKeysText(['go', 'Nowhere'], false)).toBe('go Nowhere')
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
