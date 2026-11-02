import {
  keybindingMatchesAction,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../../../shared/keybindings'

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

export function matchesNativeChatToggleShortcut(
  e: KeybindingInput,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): boolean {
  return keybindingMatchesAction('terminal.toggleNativeChat', e, platform, keybindings)
}
