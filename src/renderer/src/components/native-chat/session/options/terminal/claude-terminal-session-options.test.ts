import { describe, expect, it } from 'vitest'
import { readClaudeSessionOptionsFromTerminalScreen } from './claude-terminal-session-options'

const OPTION_LESS_MODEL_60_COLS = [
  '\u001b[?1049h\u001b[H\r',
  '\u001b[38;2;215;119;87m╭─ Claude Code ────────────────────────────────────────────╮\r',
  '│\u001b[58C│\r',
  '│\u001b[22C\u001b[39;1mWelcome back!\u001b[23C\u001b[38;2;215;119;87;22m│\r',
  '│\u001b[58C│\r',
  '│\u001b[25C ▐\u001b[48;2;0;0;0m▛███▜\u001b[49m▌\u001b[25C│\r',
  '│\u001b[25C▝▜\u001b[48;2;0;0;0m█████\u001b[49m▛▘\u001b[24C│\r',
  '│\u001b[25C  ▘▘ ▝▝  \u001b[24C│\r',
  '│\u001b[58C│\r',
  '│\u001b[24C\u001b[38;2;153;153;153mHaiku 4.5\u001b[25C\u001b[38;2;215;119;87m│\r',
  '│\u001b[20C\u001b[38;2;153;153;153mAPI Usage Billing\u001b[21C\u001b[38;2;215;119;87m│\r',
  '│\u001b[23C\u001b[38;2;153;153;153m/private/tmp\u001b[23C\u001b[38;2;215;119;87m│\r',
  '│\u001b[58C│\r',
  '╰──────────────────────────────────────────────────────────╯\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\u001b[2C\u001b[38;2;255;193;7m⚠ claude.ai connectors are disabled because ANTHROPIC_AP…\r',
  '\u001b[38;2;136;136;136m────────────────────────────────────────────────────────────\r',
  '\u001b[0m❯ \u001b[2mTry "how does <filepath> work?"\r',
  '\u001b[38;2;136;136;136;22m────────────────────────────────────────────────────────────\r',
  '\u001b[2C\u001b[38;2;255;193;7m⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_…\r',
  '\u001b[2C\u001b[96m🤖\u001b[38;2;153;153;153m \u001b[96mHaiku 4.5\u001b[37m | \u001b[93m📁\u001b[38;2;153;153;153m \u001b[92mtmp\u001b[37m | \u001b[2C\u001b[95m⚡️ \u001b[38;2;153;153;153m \u001b[95m11.9% · 23.8k tokens\r',
  '\u001b[2C\u001b[38;2;255;107;128m⏵⏵ bypass permissions on\u001b[38;2;153;153;153m (shift+tab to cycle)\u001b[4A\u001b[45D\u001b[0m\u001b[?2004h\u001b[?1004h\u001b[?1003h'
].join('\n')

describe('Claude terminal session option detection', () => {
  it('reads a real narrow frame whose option-less model carries no metadata', () => {
    // Without effort or same-line billing, the working directory is the remaining model-row landmark.
    expect(readClaudeSessionOptionsFromTerminalScreen(OPTION_LESS_MODEL_60_COLS)).toEqual({
      model: 'haiku'
    })
  })
})
