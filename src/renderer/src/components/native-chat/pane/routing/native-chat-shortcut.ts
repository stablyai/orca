import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import type {
  KeybindingInput,
  KeybindingOverrides
} from '../../../../../../shared/keybindings/types'

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
