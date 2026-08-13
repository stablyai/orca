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

/**
 * Resolves a digit-index keybinding input into a provider account switch action, or null.
 * Mirrors the workspace/tab digit-index resolution; split out to stay under the line budget.
 */
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
