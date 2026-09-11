// @vitest-environment happy-dom

// The equivalence proof in src/shared renders through @xterm/headless, but the pane that actually
// feeds the renderer guard is @xterm/xterm — a different package on a neighbouring beta. Byte
// identity proven against one emulator says nothing about the other, so this drives the corpus
// through the real renderer emulator and pins the two projections to each other.
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { describe, expect, it } from 'vitest'
import {
  createRendererParityTerminal,
  writeToTerminal
} from '../../../../shared/terminal-restore-parity-fixture'
import { buildTerminalVisibleScreenText } from '../../../../shared/terminal-visible-screen-projection'
import { activateOrcaTerminalUnicodeProvider } from '../../../../shared/terminal-unicode-provider'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../../../shared/terminal-scrollback-policy'
import { findCredentialPromptIndex } from '../../../../shared/terminal-credential-prompt-detection'
import { LEGITIMATE_AGENT_SCREENS } from '../../../../shared/terminal-legitimate-agent-screens-corpus'
import { LIVE_CREDENTIAL_SURFACES } from '../../../../shared/terminal-live-credential-surfaces-corpus'

const VIEWPORT = { cols: 120, rows: 24 }

function renderThroughRendererEmulator(lines: string[]): Promise<string> {
  const terminal = new Terminal({
    cols: VIEWPORT.cols,
    rows: VIEWPORT.rows,
    scrollback: DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
    allowProposedApi: true,
    vtExtensions: { kittyKeyboard: true }
  })
  terminal.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(terminal)
  return new Promise((resolve) => {
    terminal.write(`\x1b[H\x1b[2J${lines.join('\r\n')}`, () => {
      resolve(buildTerminalVisibleScreenText(terminal))
      terminal.dispose()
    })
  })
}

async function renderThroughHeadlessEmulator(lines: string[]): Promise<string> {
  const { terminal } = createRendererParityTerminal(VIEWPORT)
  await writeToTerminal(terminal, `\x1b[H\x1b[2J${lines.join('\r\n')}`)
  return buildTerminalVisibleScreenText(terminal)
}

describe('@xterm/xterm and @xterm/headless project the same visible screen', () => {
  it.each([...LIVE_CREDENTIAL_SURFACES, ...LEGITIMATE_AGENT_SCREENS])(
    'agrees byte-for-byte on %s',
    async (_name, lines) => {
      expect(await renderThroughRendererEmulator(lines)).toBe(
        await renderThroughHeadlessEmulator(lines)
      )
    }
  )

  it.each(LIVE_CREDENTIAL_SURFACES)(
    'keeps %s detectable through the renderer emulator',
    async (_name, lines) => {
      const screen = await renderThroughRendererEmulator(lines)
      expect(findCredentialPromptIndex(screen.toLowerCase())).not.toBeNull()
    }
  )

  it.each(LEGITIMATE_AGENT_SCREENS)(
    'keeps %s passable through the renderer emulator',
    async (_name, lines) => {
      const screen = await renderThroughRendererEmulator(lines)
      expect(findCredentialPromptIndex(screen.toLowerCase())).toBeNull()
    }
  )
})
