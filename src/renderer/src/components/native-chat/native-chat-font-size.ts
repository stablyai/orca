import {
  normalizeNativeChatAppearanceSettings,
  resolveNativeChatAppearanceSettings,
  type NativeChatAppearanceSettings
} from '../../../../shared/native-chat-appearance-settings'
import {
  keybindingMatchesAction,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../../../shared/keybindings'

export function chatFontSizeForAction(
  appearance: NativeChatAppearanceSettings | undefined,
  action: Exclude<ChatFontSizeAction, null>
): NativeChatAppearanceSettings | undefined {
  if (appearance?.matchTerminalInterface) {
    return appearance
  }
  const { fontSize } = resolveNativeChatAppearanceSettings(appearance)
  return normalizeNativeChatAppearanceSettings({
    ...appearance,
    fontSize: action === 'reset' ? undefined : fontSize + (action === 'increase' ? 1 : -1)
  })
}

export type ChatFontSizeAction = 'increase' | 'decrease' | 'reset' | null

export function chatFontSizeActionForEvent(
  input: KeybindingInput,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): ChatFontSizeAction {
  if (keybindingMatchesAction('zoom.in', input, platform, keybindings, { context: 'app' })) {
    return 'increase'
  }
  if (keybindingMatchesAction('zoom.out', input, platform, keybindings, { context: 'app' })) {
    return 'decrease'
  }
  return keybindingMatchesAction('zoom.reset', input, platform, keybindings, { context: 'app' })
    ? 'reset'
    : null
}
