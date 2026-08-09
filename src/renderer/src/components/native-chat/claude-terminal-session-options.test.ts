import { describe, expect, it } from 'vitest'
import { readClaudeSessionOptionsFromTerminalScreen } from './claude-terminal-session-options'

// Captured from a live `claude` 2.1.220 startup frame by replaying the PTY
// bytes through @xterm/headless and calling serializeAddon.serialize({
// scrollback: 0 }) — byte-for-byte what TerminalPane hands the scraper. The two
// widths matter: at 100 columns the frame keeps its version and prints billing
// on the model row, at 60 it drops the version and wraps billing to its own row.

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

const FRESH_SESSION_60_COLS = [
  '\u001b[?1049h\u001b[H\r',
  '\u001b[38;2;215;119;87m╭─ Claude Code ────────────────────────────────────────────╮\r',
  '│\u001b[58C│\r',
  '│\u001b[22C\u001b[39;1mWelcome back!\u001b[23C\u001b[38;2;215;119;87;22m│\r',
  '│\u001b[58C│\r',
  '│\u001b[25C ▐\u001b[48;2;0;0;0m▛███▜\u001b[49m▌\u001b[25C│\r',
  '│\u001b[25C▝▜\u001b[48;2;0;0;0m█████\u001b[49m▛▘\u001b[24C│\r',
  '│\u001b[25C  ▘▘ ▝▝  \u001b[24C│\r',
  '│\u001b[58C│\r',
  '│\u001b[17C\u001b[38;2;153;153;153mFable 5 with high effort\u001b[17C\u001b[38;2;215;119;87m│\r',
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
  '\u001b[0m❯ \u001b[2mTry "refactor <filepath>"\r',
  '\u001b[38;2;136;136;136;22m────────────────────────────────────────────────────────────\r',
  '\u001b[2C\u001b[38;2;255;193;7m⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_…\r',
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
    // The descriptor sits eight rows under the version, below the welcome art.
    expect(readClaudeSessionOptionsFromTerminalScreen(FRESH_SESSION_100_COLS)).toEqual({
      model: 'fable',
      effort: 'high'
    })
  })

  it('reads a real 60-column frame that drops the version and wraps billing', () => {
    expect(readClaudeSessionOptionsFromTerminalScreen(FRESH_SESSION_60_COLS)).toEqual({
      model: 'fable',
      effort: 'high'
    })
  })

  it('reads a real narrow frame whose option-less model carries no metadata', () => {
    // Why: `Haiku 4.5` has no effort control and its billing wrapped to the next
    // row, so nothing marks the row as a model — only its position above the
    // working directory does.
    expect(readClaudeSessionOptionsFromTerminalScreen(OPTION_LESS_MODEL_60_COLS)).toEqual({
      model: 'haiku'
    })
  })

  it('reads an option-less model above a Windows working directory', () => {
    const screen = [
      '╭─ Claude Code ───╮',
      '│Haiku 4.5│',
      '│API Usage Billing│',
      '│C:\\work\\repo│',
      '╰─────────────╯'
    ].join('\r\n')

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({ model: 'haiku' })
  })

  it('reports nothing rather than release-notes prose when the model row is bare', () => {
    // Why: a custom model with its billing wrapped away carries no descriptor
    // metadata, so nothing in the frame identifies it. The panel shares rows
    // with the art and its borders collide (`││`) — reading past them would
    // make panel prose win the search and report a sentence as the model.
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

  it('reports nothing when a partial frame only contains wrapped billing', () => {
    const screen = [
      '╭─ Claude Code ───╮',
      '│API Usage Billing│',
      '│/repo│',
      '╰─────────────╯'
    ].join('\r\n')

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toBeNull()
  })

  it('does not reject a bare custom model whose name mentions billing', () => {
    const screen = ['╭─ Claude Code ───╮', '│billing-model│', '│/repo│', '╰─────────────╯'].join(
      '\r\n'
    )

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'billing-model'
    })
  })

  // The exact catalog `claude -p` list_models returns on CLI 2.1.220: note the
  // host offers no plain `opus`, and `sonnet` and `sonnet[1m]` are distinct.
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

  it('resolves to the host id the picker lists, not the seed family', () => {
    // Why: `opus` is not offered on this host, so reporting it would select a
    // row the picker has to invent.
    expect(
      readClaudeSessionOptionsFromTerminalScreen(
        frame('Opus 5 (1M context) with high effort · API Usage Billing'),
        DISCOVERED
      )
    ).toEqual({ model: 'opus[1m]', effort: 'high' })
  })

  it('prefers the most specific variant when a family also matches', () => {
    expect(
      readClaudeSessionOptionsFromTerminalScreen(
        frame('Sonnet 5 (1M context) with low effort · API Usage Billing'),
        DISCOVERED
      )
    ).toEqual({ model: 'sonnet[1m]', effort: 'low' })
  })

  it('keeps the plain family when the frame names no variant', () => {
    // Why: `Sonnet 5` must not be captured by the 1M-context row just because
    // that row's label happens to start with the same two tokens.
    expect(
      readClaudeSessionOptionsFromTerminalScreen(
        frame('Sonnet 5 with medium effort · API Usage Billing'),
        DISCOVERED
      )
    ).toEqual({ model: 'sonnet', effort: 'medium' })
  })

  it('falls back to a seed family the host list no longer offers', () => {
    expect(
      readClaudeSessionOptionsFromTerminalScreen(
        frame('Opus 4.8 with high effort · API Usage Billing'),
        DISCOVERED
      )
    ).toEqual({ model: 'opus', effort: 'high' })
  })

  it('still reports a custom model when the host list cannot name it', () => {
    expect(
      readClaudeSessionOptionsFromTerminalScreen(
        frame('company/my-haiku-v2 · API Usage Billing'),
        DISCOVERED
      )
    ).toEqual({ model: 'company/my-haiku-v2' })
  })

  it('reads an effort suffix the frame truncated to an ellipsis', () => {
    const screen =
      'Claude Code v2.1.220\r\n' +
      'Opus 5 (1M context) with high… · API Usage Billing\r\n' +
      '~/repo'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'opus',
      effort: 'high'
    })
  })

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

  it('matches headers from newer CLIs where the alias resolves to another version', () => {
    // Why: family labels must keep matching as `opus` moves across releases.
    const screen =
      'Claude Code v2.1.220\r\n' +
      'Opus 5 (1M context) with xhigh effort · API Usage Billing\r\n' +
      '~/repo'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'opus',
      effort: 'xhigh'
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

  it('recovers a custom model name that is not in the catalog', () => {
    const screen =
      '\u001b[1mClaude Code\u001b[0m v2.1.211\r\n' +
      '\u001b[38;2;102;102;102mmy-custom-model with high effort · API Usage Billing\r\n' +
      '~/repo'

    // Custom models have no catalog options, so effort is intentionally dropped.
    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'my-custom-model'
    })
  })

  it('recovers a custom model with no effort suffix', () => {
    const screen = 'Claude Code v2.1.211\r\ncompany/internal-opus · API Usage Billing\r\n~/repo'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'company/internal-opus'
    })
  })

  it('keeps a custom model containing a catalog label', () => {
    const screen = 'Claude Code v2.1.211\r\ncompany/my-haiku-v2 · API Usage Billing\r\n~/repo'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'company/my-haiku-v2'
    })
  })

  it('keeps a custom model whose name only starts with a catalog family', () => {
    // Why: the family must match as a whole leading word, not a bare prefix, or
    // every vendor slug built off a family name would be claimed as that model.
    const screen = 'Claude Code v2.1.211\r\nopus-internal-v3 · API Usage Billing\r\n~/repo'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'opus-internal-v3'
    })
  })

  it('ignores catalog labels outside the descriptor row', () => {
    const screen = 'Claude Code v2.1.211\r\nacme-frontier · API Usage Billing\r\n~/work/Haiku'

    expect(readClaudeSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'acme-frontier'
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
