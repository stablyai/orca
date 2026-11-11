import type { GlobalSettings, NativeChatReferenceChipMode } from '../global-settings-types'

/** Absent or unknown values mean 'full', so a hand-edited setting never hides chips by accident. */
export function nativeChatReferenceChipMode(
  settings: Pick<GlobalSettings, 'nativeChatReferenceChips'> | null | undefined
): NativeChatReferenceChipMode {
  const mode = settings?.nativeChatReferenceChips
  return mode === 'off' || mode === 'compact' ? mode : 'full'
}
