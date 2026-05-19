export async function playDesktopNotificationSound(
  customSoundPath: string | null | undefined
): Promise<boolean> {
  if (!customSoundPath) {
    return false
  }

  try {
    const result = await window.api.notifications.playSound()
    // Why: 'deduped' is expected when bursts of notifications coalesce — not a failure.
    if (!result.played && result.reason !== 'deduped') {
      console.warn('Failed to play custom notification sound:', result.reason)
    }
    return result.played
  } catch (err) {
    console.warn('Failed to play custom notification sound:', err)
    return false
  }
}
