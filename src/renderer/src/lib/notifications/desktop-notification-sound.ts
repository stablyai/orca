import { usesCustomNotificationSound } from '../../../../shared/notification-settings-types'

export async function playDesktopNotificationSound(
  customSoundId: string | null | undefined,
  customSoundVolume?: number | null
): Promise<boolean> {
  if (!usesCustomNotificationSound(customSoundId)) {
    return false
  }

  try {
    const result = await window.api.notifications.playSound({
      volume: customSoundVolume ?? undefined
    })
    // Why: 'deduped' (burst coalescing) and 'focus-active' (macOS Focus) are expected — not failures.
    if (!result.played && result.reason !== 'deduped' && result.reason !== 'focus-active') {
      console.warn('Failed to play custom notification sound:', result.reason)
    }
    return result.played
  } catch (err) {
    console.warn('Failed to play custom notification sound:', err)
    return false
  }
}
