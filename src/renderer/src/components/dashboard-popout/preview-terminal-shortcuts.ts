import {
  resolveTerminalShortcutAction,
  type MacOptionAsAlt,
  type TerminalShortcutAction
} from '@/components/terminal-pane/terminal-shortcut-policy'
import { getLayoutCharacterForCode } from '@/lib/keyboard-layout/layout-base-character'
import type { OptionKeyLocationState } from '@/lib/keyboard-layout/option-key-location-state'
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
  optionKeyLocations: OptionKeyLocationState
  keybindings: KeybindingOverrides | undefined
  /** Host-input facts relayed with the card; null falls back to client-OS routing. */
  terminalInput: DashboardCardTerminalInput | null
  /** Live kitty-protocol flags mirrored from this pty's output. */
  getKittyKeyboardFlags: () => number
  /** The user's policy for chords shared with shells and TUIs. */
  terminalShortcutPolicy: TerminalShortcutPolicy | null | undefined
}

/** Use pane input policy for preview bytes; return pane actions for caller handling and leave deferred TUI chords to xterm. */
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
    context.optionKeyLocations,
    context.clientPlatform === 'win32',
    context.keybindings,
    // Why: PSReadLine on a local ConPTY binds Ctrl+←/→ itself; \eb/\ef would print stray b/f.
    () => context.terminalInput?.localWindowsConpty === true,
    context.getKittyKeyboardFlags,
    getLayoutCharacterForCode,
    () => context.terminalInput?.windowsShiftEnterEncoding ?? 'alt-enter',
    // Why: byte protocols follow the pty's host, which differs from the client OS on remote runtimes.
    () => hostPlatform === 'win32',
    // Preserve terminal-first tab.close aliases such as Ctrl+W word-kill, matching the pane.
    normalizeTerminalShortcutPolicy(context.terminalShortcutPolicy),
    () => context.terminalInput?.ctrlEnterCsiU === true
  )
}
