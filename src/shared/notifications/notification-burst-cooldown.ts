export const NOTIFICATION_COOLDOWN_MS = 5000
const MAX_RECENT_NOTIFICATION_KEYS = 50

export function isNotificationCooldownActive(lastSentAt: number | undefined, now: number): boolean {
  // Two-sided so stamps reserved out of order still collapse, while a backwards clock step
  // past the window releases the key instead of holding it until the clock catches up.
  return lastSentAt !== undefined && Math.abs(now - lastSentAt) < NOTIFICATION_COOLDOWN_MS
}

function pruneRecentNotifications(recentNotifications: Map<string, number>, now: number): void {
  if (recentNotifications.size <= MAX_RECENT_NOTIFICATION_KEYS) {
    return
  }

  for (const [key, ts] of recentNotifications) {
    if (!isNotificationCooldownActive(ts, now)) {
      recentNotifications.delete(key)
    }
  }

  while (recentNotifications.size > MAX_RECENT_NOTIFICATION_KEYS) {
    const oldest = recentNotifications.keys().next()
    if (oldest.done) {
      break
    }
    recentNotifications.delete(oldest.value)
  }
}

export function reserveNotificationCooldown(
  recentNotifications: Map<string, number>,
  dedupeKey: string,
  now: number
): boolean {
  if (isNotificationCooldownActive(recentNotifications.get(dedupeKey), now)) {
    return false
  }
  recentNotifications.delete(dedupeKey)
  recentNotifications.set(dedupeKey, now)
  pruneRecentNotifications(recentNotifications, now)
  return true
}
