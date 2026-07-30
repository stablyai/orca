import {
  resolveTerminalShortcutAction,
  type MacOptionAsAlt,
  type TerminalShortcutAction
} from '@/components/terminal-pane/terminal-shortcut-policy'
import { getLayoutBaseCharacterForCode } from '@/lib/keyboard-layout/layout-base-character'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import {
  normalizeTerminalShortcutPolicy,
  type KeybindingOverrides,
  type TerminalShortcutPolicy
} from '../../../../shared/keybindings'

export type PreviewShortcutContext = {
  clientPlatform: NodeJS.Platform
  macOptionAsAlt: MacOptionAsAlt
  /** Location of the physically held Option key (character keys report their own). */
  optionKeyLocation: number
  keybindings: KeybindingOverrides | undefined
  /** Host-input facts relayed with the card; null falls back to client-OS routing. */
  terminalInput: DashboardCardTerminalInput | null
  /** Live kitty-protocol flags mirrored from this pty's output. */
  kittyKeyboardActive: () => boolean
  /** The user's setting; terminal-first yields the tab.close alias to the shell. */
  terminalShortcutPolicy: TerminalShortcutPolicy | null | undefined
}

/**
 * Runs the preview terminal's keys through the same policy a pane uses, so the
 * dashboard encodes word-kills, Option chords, and modified Enter identically.
 * Every pane-scoped verdict (splits, search, focus) still comes back — the
 * caller swallows those rather than leaking raw bytes to the agent.
 */
export function resolvePreviewShortcutAction(
  event: KeyboardEvent,
  context: PreviewShortcutContext
): TerminalShortcutAction | null {
  const isMac = context.clientPlatform === 'darwin'
  const hostPlatform = context.terminalInput?.hostPlatform ?? context.clientPlatform
  return resolveTerminalShortcutAction(
    event,
    isMac,
    context.macOptionAsAlt,
    context.optionKeyLocation,
    context.clientPlatform === 'win32',
    context.keybindings,
    // Why: PSReadLine on a local ConPTY binds Ctrl+←/→ itself; \eb/\ef would print stray b/f.
    () => context.terminalInput?.localWindowsConpty === true,
    context.kittyKeyboardActive,
    getLayoutBaseCharacterForCode,
    () => context.terminalInput?.windowsShiftEnterEncoding ?? 'alt-enter',
    // Why: byte protocols follow the pty's host, which differs from the client OS on remote runtimes.
    () => hostPlatform === 'win32',
    // Why: without it a terminal-first user's remapped tab.close chord — Ctrl+W
    // is a shell word-kill — reaches the shell in the pane but is swallowed here.
    normalizeTerminalShortcutPolicy(context.terminalShortcutPolicy)
  )
}
