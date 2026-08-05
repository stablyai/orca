import {
  matchKeybindingDigitIndex,
  type KeybindingInput,
  type KeybindingMatchOptions,
  type KeybindingOverrides
} from './keybindings'

export type ProviderAccountShortcutAction = {
  type: 'switchProviderAccountIndex'
  provider: 'claude' | 'codex'
  index: number
}

// Why: split out of window-shortcut-policy.ts to stay under its line budget;
// mirrors the workspace/tab digit-index resolution there.
export function resolveAccountShortcut(
  input: KeybindingInput,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides | undefined,
  options: KeybindingMatchOptions
): ProviderAccountShortcutAction | null {
  for (const provider of ['claude', 'codex'] as const) {
    const index = matchKeybindingDigitIndex(
      `accounts.${provider}.selectByIndex`,
      input,
      platform,
      keybindings,
      options
    )
    if (index !== null) {
      return { type: 'switchProviderAccountIndex', provider, index }
    }
  }
  return null
}
