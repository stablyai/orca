import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  normalizeNativeChatAppearanceSettings,
  type NativeChatAppearanceSettings
} from '../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import { useAppStore } from '../../../store/index'

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

let appearanceWrite: Promise<boolean> = Promise.resolve(true)

/** Resolves false when the write failed; only a throwing `persist` can report that. */
export function writeNativeChatAppearance(
  change: AppearanceChange,
  persist?: PersistAppearance
): Promise<boolean> {
  appearanceWrite = appearanceWrite
    .then(async () => {
      const { settings, updateSettings } = useAppStore.getState()
      if (!settings) {
        return false
      }
      const current = normalizeNativeChatAppearanceSettings(settings.nativeChatAppearance)
      const next = normalizeNativeChatAppearanceSettings(change(current))
      if (sameAppearance(current, next)) {
        return true
      }
      await (persist ?? updateSettings)({ nativeChatAppearance: next })
      return true
    })
    .catch((error) => {
      console.error('Failed to update chat appearance:', error)
      return false
    })
  return appearanceWrite
}
