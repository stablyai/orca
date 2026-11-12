import type { GlobalSettings } from '../global-settings-types'

/** How chat links that only repeat an issue or PR ID show. */
export type NativeChatReferenceChipMode = NonNullable<GlobalSettings['nativeChatReferenceChips']>

/** Absent or unknown values mean 'full', so a hand-edited setting never hides chips by accident. */
export function nativeChatReferenceChipMode(
  settings: Pick<GlobalSettings, 'nativeChatReferenceChips'> | null | undefined
): NativeChatReferenceChipMode {
  const mode = settings?.nativeChatReferenceChips
  return mode === 'off' || mode === 'compact' ? mode : 'full'
}
