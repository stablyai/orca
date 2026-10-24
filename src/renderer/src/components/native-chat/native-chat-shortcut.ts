import {
  keybindingMatchesAction,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../../../shared/keybindings'

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

/** True when the event is the user's binding for the terminal ⇄ native-chat toggle. */
export function matchesNativeChatToggleShortcut(
  e: KeybindingInput,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): boolean {
  return keybindingMatchesAction('terminal.toggleNativeChat', e, platform, keybindings)
}
