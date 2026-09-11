// A detector fed a differently-shaped string is a detector that silently stops working. The
// main-process credential guard was tuned against newline-joined screen rows; the renderer holds
// an xterm.js grid, and "the last N non-blank rows of a grid" is not the same operation as
// "the tail of a string". These cases pin the two shapes to each other.
import { describe, expect, it } from 'vitest'
import { createRendererParityTerminal, writeToTerminal } from './terminal-restore-parity-fixture'
import {
  buildTerminalVisibleScreenText,
  readTerminalVisibleLines,
  visibleNonBlankTerminalLines
} from './terminal-visible-screen-projection'
import { findCredentialPromptIndex } from './terminal-credential-prompt-detection'
import { LEGITIMATE_AGENT_SCREENS } from './terminal-legitimate-agent-screens-corpus'
import { LIVE_CREDENTIAL_SURFACES } from './terminal-live-credential-surfaces-corpus'

const VIEWPORT = { cols: 120, rows: 24 }

async function renderScreen(lines: string[], dims = VIEWPORT): Promise<string> {
  const { terminal } = createRendererParityTerminal(dims)
  await writeToTerminal(terminal, `\x1b[H\x1b[2J${lines.join('\r\n')}`)
  return buildTerminalVisibleScreenText(terminal)
}

/** The shape the main-process corpus feeds `detectTerminalWaitBlockedReason`. */
function mainShapedScreen(lines: string[]): string {
  return visibleNonBlankTerminalLines(lines).join('\n')
}

describe('buildTerminalVisibleScreenText', () => {
  it.each([...LIVE_CREDENTIAL_SURFACES, ...LEGITIMATE_AGENT_SCREENS])(
    'renders %s to the same string the main-process corpus uses',
    async (_name, lines) => {
      expect(await renderScreen(lines)).toBe(mainShapedScreen(lines))
    }
  )

  it.each(LIVE_CREDENTIAL_SURFACES)(
    'keeps %s detectable through the grid',
    async (_name, lines) => {
      const screen = await renderScreen(lines)
      expect(findCredentialPromptIndex(screen.toLowerCase())).not.toBeNull()
    }
  )

  it.each(LEGITIMATE_AGENT_SCREENS)('keeps %s clean through the grid', async (_name, lines) => {
    const screen = await renderScreen(lines)
    expect(findCredentialPromptIndex(screen.toLowerCase())).toBeNull()
  })

  it('drops the blank viewport rows a short dialog leaves behind', async () => {
    // A 3-row dialog in a 24-row grid is 21 blank rows; a naive last-N-rows slice would hand the
    // detector nothing but whitespace and the prompt would sail through.
    const screen = await renderScreen(['Authentication required', '', 'Enter your API key:'])
    expect(screen).toBe('Authentication required\nEnter your API key:')
    expect(findCredentialPromptIndex(screen.toLowerCase())).not.toBeNull()
  })

  it('reads the viewport, not the scrollback an answered prompt fell into', async () => {
    const { terminal } = createRendererParityTerminal({ cols: 120, rows: 4 })
    await writeToTerminal(
      terminal,
      '\x1b[H\x1b[2JEnter your API key:\r\nSigned in as neil@example.com.\r\n' +
        'OpenAI Codex\r\ndirectory: ~/repo\r\n› Ask Codex to do anything\r\n'
    )
    const screen = buildTerminalVisibleScreenText(terminal)
    expect(screen).not.toContain('Enter your API key')
    expect(findCredentialPromptIndex(screen.toLowerCase())).toBeNull()
  })

  it('right-trims cells the grid pads out to the full column width', async () => {
    const { terminal } = createRendererParityTerminal({ cols: 40, rows: 3 })
    await writeToTerminal(terminal, '\x1b[H\x1b[2JPassword:')
    expect(readTerminalVisibleLines(terminal)).toEqual(['Password:', '', ''])
    expect(buildTerminalVisibleScreenText(terminal)).toBe('Password:')
  })

  it('reads the alternate screen a full-screen TUI draws on', async () => {
    const { terminal } = createRendererParityTerminal(VIEWPORT)
    await writeToTerminal(terminal, 'shell scrollback\r\n\x1b[?1049h\x1b[H\x1b[2JEnter your OTP:')
    const screen = buildTerminalVisibleScreenText(terminal)
    expect(screen).toBe('Enter your OTP:')
    expect(findCredentialPromptIndex(screen.toLowerCase())).not.toBeNull()
  })
})
