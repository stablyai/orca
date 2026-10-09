import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  normalizeNativeChatAppearanceSettings,
  type NativeChatAppearanceSettings
} from '../../../../shared/native-chat-appearance-settings'
import { useAppStore } from '../../store'

type AppearanceChange = (
  current: NativeChatAppearanceSettings | undefined
) => NativeChatAppearanceSettings | undefined
type PersistAppearance = (updates: Partial<GlobalSettings>) => void | Promise<void>

function sameAppearance(
  left: NativeChatAppearanceSettings | undefined,
  right: NativeChatAppearanceSettings | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {})
  const rightEntries = Object.entries(right ?? {})
  const rightValues = new Map(rightEntries)
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value]) => rightValues.has(key) && Object.is(value, rightValues.get(key))
    )
  )
}

let appearanceWrite = Promise.resolve()

export function writeNativeChatAppearance(
  change: AppearanceChange,
  persist?: PersistAppearance
): Promise<void> {
  appearanceWrite = appearanceWrite
    .then(async () => {
      const { settings, updateSettings } = useAppStore.getState()
      if (!settings) {
        return
      }
      const current = normalizeNativeChatAppearanceSettings(settings.nativeChatAppearance)
      const next = normalizeNativeChatAppearanceSettings(change(current))
      if (sameAppearance(current, next)) {
        return
      }
      await (persist ?? updateSettings)({ nativeChatAppearance: next })
    })
    .catch((error) => console.error('Failed to update chat appearance:', error))
  return appearanceWrite
}
