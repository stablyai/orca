// The renderer half of the two-sided corpus: every screen that blocks a main-process PTY write
// must block a renderer paste, and every legitimate agent screen must block neither. These run
// through the real registry and a real xterm grid, not a hand-built string.
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRendererParityTerminal,
  writeToTerminal
} from '../../../shared/terminal-restore-parity-fixture'
import { LEGITIMATE_AGENT_SCREENS } from '../../../shared/terminal-legitimate-agent-screens-corpus'
import { LIVE_CREDENTIAL_SURFACES } from '../../../shared/terminal-live-credential-surfaces-corpus'
import { registerPtyVisibleScreen } from '@/components/terminal-pane/pty-visible-screen-registry'
import { isAgentPasteBlockedByCredentialPrompt } from './agent-paste-credential-prompt-guard'

const PTY_ID = 'pty-1'
const cleanups: (() => void)[] = []

async function showOnPane(lines: string[]): Promise<void> {
  const { terminal } = createRendererParityTerminal({ cols: 120, rows: 24 })
  await writeToTerminal(terminal, `\x1b[H\x1b[2J${lines.join('\r\n')}`)
  cleanups.push(registerPtyVisibleScreen(PTY_ID, terminal))
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

describe('isAgentPasteBlockedByCredentialPrompt', () => {
  it.each(LIVE_CREDENTIAL_SURFACES)('refuses a paste into %s', async (_name, lines) => {
    await showOnPane(lines)
    expect(isAgentPasteBlockedByCredentialPrompt(PTY_ID)).toBe(true)
  })

  it.each(LEGITIMATE_AGENT_SCREENS)('allows a paste into %s', async (_name, lines) => {
    await showOnPane(lines)
    expect(isAgentPasteBlockedByCredentialPrompt(PTY_ID)).toBe(false)
  })

  it('allows the paste when no pane owns the PTY', () => {
    // Absence of evidence, not evidence of a clean screen: refusing here would block every
    // launch whose pane has not mounted yet, and runtime-routed writes still meet the
    // main-process fence.
    expect(isAgentPasteBlockedByCredentialPrompt('pty-never-registered')).toBe(false)
  })

  it('stops consulting a pane that unregistered', async () => {
    await showOnPane(['Enter your API key:'])
    expect(isAgentPasteBlockedByCredentialPrompt(PTY_ID)).toBe(true)
    cleanups.splice(0).forEach((cleanup) => cleanup())
    expect(isAgentPasteBlockedByCredentialPrompt(PTY_ID)).toBe(false)
  })

  it('clears itself once the dialog is answered', async () => {
    await showOnPane(['Sign in to Antigravity', 'Enter the code: KXTD-9PQR'])
    expect(isAgentPasteBlockedByCredentialPrompt(PTY_ID)).toBe(true)
    await showOnPane(['Signed in as neil@example.com.', '', '› Ask Codex to do anything'])
    expect(isAgentPasteBlockedByCredentialPrompt(PTY_ID)).toBe(false)
  })

  it('only reads the PTY it was asked about', async () => {
    await showOnPane(['Enter your API key:'])
    expect(isAgentPasteBlockedByCredentialPrompt('pty-2')).toBe(false)
  })
})
