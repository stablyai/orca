import { useAppStore } from '../../store'

/** Derives the composer's dictation-related booleans from live voice settings + dictation
 *  state. Sibling to use-native-chat-dictation-actions.ts (which dispatches the
 *  toggle/start/stop controls); this one only reads. */
export function useNativeChatDictationState(dictationPressed: boolean): {
  isDictating: boolean
  isDictationHoldMode: boolean
  dictationDisabled: boolean
} {
  const dictationState = useAppStore((store) => store.dictationState)
  const voiceSettings = useAppStore((store) => store.settings?.voice)
  const isDictationHoldMode = voiceSettings?.dictationMode === 'hold'
  const dictationDisabled = voiceSettings?.enabled !== true || !voiceSettings.sttModel
  const isDictating =
    dictationPressed ||
    dictationState === 'starting' ||
    dictationState === 'listening' ||
    dictationState === 'stopping'
  return { isDictating, isDictationHoldMode, dictationDisabled }
}
