import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { ORCA_ADVERTISED_TERM_PROGRAM, ORCA_TRUE_TERM_PROGRAM } from './terminal-brand-env'

/**
 * Contract test against a real `grok` binary, when one is installed.
 *
 * The override only pays off if grok actually classifies the brand we claim.
 * Asserting that against the shipped binary catches the case where grok renames
 * or drops a brand and Orca silently returns to unclassified — which is exactly
 * how the truncated-link bug behaved.
 *
 * Skipped when grok is absent so CI and contributor machines stay green.
 */
function grokDoctorTerminalLine(termProgram: string): string | null {
  try {
    const stdout = execFileSync('grok', ['doctor'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        TERM_PROGRAM: termProgram,
        TERM_PROGRAM_VERSION: '1.0.0',
        // Why: grok falls back to these markers when TERM_PROGRAM is absent or
        // overwritten, so a developer's real terminal would leak into the result.
        ITERM_SESSION_ID: '',
        ITERM_PROFILE: '',
        LC_TERMINAL: '',
        TERM_SESSION_ID: '',
        WEZTERM_VERSION: '',
        KITTY_WINDOW_ID: '',
        VTE_VERSION: '',
        WT_SESSION: '',
        TERMINAL_EMULATOR: '',
        VSCODE_GIT_ASKPASS_MAIN: '',
        CURSOR_TRACE_ID: '',
        TMUX: '',
        STY: ''
      }
    })
    return stdout.split('\n').find((line) => /^\s*\S\s+terminal\s{2,}/.test(line)) ?? null
  } catch {
    return null
  }
}

const grokTerminalLine = grokDoctorTerminalLine(ORCA_TRUE_TERM_PROGRAM)
const describeWithGrok = grokTerminalLine === null ? describe.skip : describe

describeWithGrok('grok terminal-brand contract', () => {
  it('classifies Orca’s own brand as unknown, which suppresses OSC 8', () => {
    expect(grokTerminalLine).toMatch(/Unknown/i)
  })

  it('classifies the advertised brand as a terminal it emits hyperlinks for', () => {
    expect(grokDoctorTerminalLine(ORCA_ADVERTISED_TERM_PROGRAM)).toMatch(/VS Code/i)
  })
})
