import {
  applyNativeChatSessionOptionSettingsMutation,
  resolveStructuredLaunchSeedOptions
} from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import type { PersistedNativeChatSessionOptions } from '../../../../shared/native-chat/input/native-chat-session-options'

/** Replay every host mutation in order, exactly as the runtime does. */
export function seededByNextLaunch(
  calls: readonly unknown[][]
): Record<string, string> | undefined {
  let persisted: PersistedNativeChatSessionOptions | undefined
  for (const [, mutation] of calls) {
    persisted =
      applyNativeChatSessionOptionSettingsMutation(
        persisted,
        mutation as Parameters<typeof applyNativeChatSessionOptionSettingsMutation>[1]
      ) ?? persisted
  }
  return resolveStructuredLaunchSeedOptions(persisted, 'codex')
}

export const OPTIONS = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    },
    {
      id: 'gpt-fast',
      label: 'GPT Fast',
      isDefault: false,
      defaultEffort: 'low',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' }
      ]
    }
  ],
  current: { model: 'gpt-live', effort: 'medium' }
}

export const FAST_OPTIONS = {
  ...OPTIONS,
  models: OPTIONS.models.map((model) => ({ ...model, supportsFastMode: true })),
  fastModeSupport: { supported: true },
  current: { ...OPTIONS.current, fastMode: false, confirmed: ['fastMode'] }
}
