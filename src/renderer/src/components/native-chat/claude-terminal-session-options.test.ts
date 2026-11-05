import { describe, expect, it } from 'vitest'
import { readClaudeSessionOptionsFromTerminalScreen } from './claude-terminal-session-options'

// Captured Claude 2.1.220 xterm/headless screen serializations: narrow frames omit version and wrap billing.

const FRESH_SESSION_100_COLS = [
  '\u001b[?1049h\u001b[H\r',
  '\u001b[38;2;215;119;87m╭───\u001b[1CClaude Code\u001b[1C\u001b[38;2;153;153;153mv2.1.220\u001b[1C\u001b[38;2;215;119;87m─────────────────────────────────────────────────────────────────────────╮\r',
  '│\u001b[50C\u001b[2m│\u001b[1C\u001b[22;1mTips for getting started\u001b[22C\u001b[22m│\r',
  '│\u001b[19C\u001b[39;1mWelcome back!\u001b[18C\u001b[38;2;215;119;87;22;2m│\u001b[1C\u001b[0mRun\u001b[1C/init\u001b[1Cto\u001b[1Ccreate\u001b[1Ca\u001b[1CCLAUDE.md\u001b[1Cfile\u001b[1Cwith\u001b[1Cin…\u001b[1C\u001b[38;2;215;119;87m│\r',
  '│\u001b[50C\u001b[2m│\u001b[1C\u001b[22m─────────────────────────────────────────────\u001b[1C│\r',
  "│\u001b[21C ▐\u001b[48;2;0;0;0m▛███▜\u001b[49m▌\u001b[21C\u001b[2m│\u001b[1C\u001b[22;1mWhat's new\u001b[36C\u001b[22m│\r",
  '│\u001b[21C▝▜\u001b[48;2;0;0;0m█████\u001b[49m▛▘\u001b[20C\u001b[2m│\u001b[1C\u001b[0mBug\u001b[1Cfixes\u001b[1Cand\u001b[1Creliability\u001b[1Cimprovements\u001b[8C\u001b[38;2;215;119;87m│\r',
  '│\u001b[21C  ▘▘ ▝▝  \u001b[20C\u001b[2m│\u001b[1C\u001b[0mAdded\u001b[1CClaude\u001b[1COpus\u001b[1C5\u001b[1C(`claude-opus-5`),\u001b[1Cnow\u001b[1Ct…\u001b[1C\u001b[38;2;215;119;87m│\r',
  '│\u001b[50C\u001b[2m│\u001b[1C\u001b[0mAdded\u001b[1C`sandbox.network.strictAllowlist`\u001b[1Csett…\u001b[1C\u001b[38;2;215;119;87m│\r',
  '│\u001b[3C\u001b[38;2;153;153;153mFable 5 with high effort · API Usage Billing\u001b[3C\u001b[38;2;215;119;87;2m│\u001b[1C\u001b[38;2;153;153;153;22;3m/release-notes for more\u001b[23C\u001b[38;2;215;119;87;23m│\r',
  '│\u001b[19C\u001b[38;2;153;153;153m/private/tmp\u001b[19C\u001b[38;2;215;119;87;2m│\u001b[47C\u001b[22m│\r',
  '╰──────────────────────────────────────────────────────────────────────────────────────────────────╯\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\u001b[2C\u001b[38;2;255;193;7m⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and …\r',
  '\u001b[38;2;136;136;136m────────────────────────────────────────────────────────────────────────────────────────────────────\r',
  '\u001b[0m❯ \u001b[2mTry "fix typecheck errors"\r',
  '\u001b[38;2;136;136;136;22m────────────────────────────────────────────────────────────────────────────────────────────────────\r',
  '\u001b[2C\u001b[38;2;255;193;7m⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker\u001b[38;2;153;153;153m · restart with CLAUDE_COD…\r',
  '\u001b[2C\u001b[96m🤖\u001b[38;2;153;153;153m \u001b[96mFable 5\u001b[37m | \u001b[93m📁\u001b[38;2;153;153;153m \u001b[92mtmp\u001b[37m | \u001b[2C\u001b[95m⚡️ \u001b[38;2;153;153;153m \u001b[95m11.9% · 23.8k tokens\r',
  '\u001b[2C\u001b[38;2;255;107;128m⏵⏵ bypass permissions on\u001b[38;2;153;153;153m (shift+tab to cycle)\u001b[4A\u001b[45D\u001b[0m\u001b[?2004h\u001b[?1004h\u001b[?1003h'
].join('\n')

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

const EFFORT = {
  id: 'effort',
  label: 'Effort',
  kind: {
    type: 'select' as const,
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ],
    defaultValue: 'high'
  },
  apply: {}
}

describe('Claude terminal session option detection', () => {
  it('reads the model from a real 100-column startup frame', () => {
    expect(readClaudeSessionOptionsFromTerminalScreen(FRESH_SESSION_100_COLS)).toEqual({
      model: 'fable',
      effort: 'high'
    })
  })

  it('reads a real narrow frame whose option-less model carries no metadata', () => {
    // Without effort or same-line billing, the working directory is the remaining model-row landmark.
    expect(readClaudeSessionOptionsFromTerminalScreen(OPTION_LESS_MODEL_60_COLS)).toEqual({
      model: 'haiku'
    })
  })

  it('reports nothing rather than release-notes prose when the model row is bare', () => {
    // A bare custom model has no metadata; adjacent release-panel prose must not win through colliding borders.
    const screen = [
      '╭─── Claude Codev2.1.220 ───────────────────────╮',
      '││Runs faster · uses fewer tokens│',
      '│ ▐▛███▜▌│What‽s new│',
      '│acme-frontier│',
      '│API Usage Billing│',
      '│/repo││',
      '╰───────────────────────────────────────────────╯'
    ].join('\r\n')

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toBeNull()
  })

  // Actual CLI 2.1.220 catalog: opus has only a 1M variant, while sonnet offers both context sizes.
  const DISCOVERED = [
    { id: 'opus[1m]', label: 'Opus (1M context)', options: [EFFORT] },
    { id: 'sonnet', label: 'Sonnet', options: [EFFORT] },
    { id: 'sonnet[1m]', label: 'Sonnet 5 (1M context)', options: [EFFORT] },
    { id: 'fable', label: 'Fable', options: [EFFORT] },
    { id: 'haiku', label: 'Haiku', options: [] }
  ]

  function frame(descriptor: string): string {
    return `Claude Code v2.1.220\r\n${descriptor}\r\n~/repo`
  }

  it('prefers the most specific variant when a family also matches', () => {
    expect(
      readClaudeSessionOptionsFromTerminalScreen(
        frame('Sonnet 5 (1M context) with low effort · API Usage Billing'),
        DISCOVERED
      )
    ).toEqual({ model: 'sonnet[1m]', effort: 'low' })
  })

  it('keeps the plain family when the frame names no variant', () => {
    // A plain family name must not match a context variant merely through shared leading tokens.
    expect(
      readClaudeSessionOptionsFromTerminalScreen(
        frame('Sonnet 5 with medium effort · API Usage Billing'),
        DISCOVERED
      )
    ).toEqual({ model: 'sonnet', effort: 'medium' })
  })

  it('keeps a custom model whose name only starts with a catalog family', () => {
    // Require a whole leading family word so vendor slugs cannot impersonate catalog families.
    const screen = 'Claude Code v2.1.211\r\nopus-internal-v3 · API Usage Billing\r\n~/repo'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'opus-internal-v3'
    })
  })

  it('recovers a custom model when xterm joins the descriptor to the header', () => {
    const screen =
      '\u001b[?1049h\u001b[H▐▛███▜▌Claude Codev2.1.211' +
      '▝▜█████▛▘acme-frontier with medium effort · API Usage Billing'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'acme-frontier'
    })
  })
})
