type AnnouncedAgentNotification = {
  worktreeId: string
  notificationId: string
  claimToken: symbol
}

type ClaimedAgentNotificationId = {
  notificationId: string
  claimToken: symbol
  supersededNotificationId?: string
}

const MAX_TRACKED_PANES = 128

const announcedNotificationByPaneKey = new Map<string, AnnouncedAgentNotification>()

export function claimAnnouncedAgentNotificationId(
  paneKey: string,
  worktreeId: string,
  candidateNotificationId: string
): ClaimedAgentNotificationId {
  const existing = announcedNotificationByPaneKey.get(paneKey)
  if (existing?.worktreeId === worktreeId) {
    // Re-insert so map order stays least-recently-announced first for eviction.
    announcedNotificationByPaneKey.delete(paneKey)
    announcedNotificationByPaneKey.set(paneKey, existing)
    return { notificationId: existing.notificationId, claimToken: existing.claimToken }
  }

  let supersededNotificationId = existing?.notificationId
  const claimToken = Symbol(paneKey)
  announcedNotificationByPaneKey.delete(paneKey)
  announcedNotificationByPaneKey.set(paneKey, {
    worktreeId,
    notificationId: candidateNotificationId,
    claimToken
  })
  if (announcedNotificationByPaneKey.size > MAX_TRACKED_PANES) {
    const oldestPaneKey = announcedNotificationByPaneKey.keys().next().value
    if (oldestPaneKey !== undefined) {
      const evicted = announcedNotificationByPaneKey.get(oldestPaneKey)
      announcedNotificationByPaneKey.delete(oldestPaneKey)
      supersededNotificationId = evicted?.notificationId
    }
  }
  return {
    notificationId: candidateNotificationId,
    claimToken,
    ...(supersededNotificationId ? { supersededNotificationId } : {})
  }
}

export function isAnnouncedAgentNotificationClaimCurrent(claimToken: symbol): boolean {
  for (const announced of announcedNotificationByPaneKey.values()) {
    if (announced.claimToken === claimToken) {
      return true
    }
  }
  return false
}

export function transferAnnouncedAgentNotificationClaim(
  fromPaneKey: string,
  toPaneKey: string
): string | undefined {
  const announced = announcedNotificationByPaneKey.get(fromPaneKey)
  if (!announced || fromPaneKey === toPaneKey) {
    return undefined
  }
  const supersededNotificationId = announcedNotificationByPaneKey.get(toPaneKey)?.notificationId
  announcedNotificationByPaneKey.delete(fromPaneKey)
  announcedNotificationByPaneKey.delete(toPaneKey)
  announcedNotificationByPaneKey.set(toPaneKey, announced)
  return supersededNotificationId
}

export function takeAnnouncedAgentNotificationIds(paneKey: string): readonly string[] {
  const announced = announcedNotificationByPaneKey.get(paneKey)
  if (!announced) {
    return []
  }
  announcedNotificationByPaneKey.delete(paneKey)
  return [announced.notificationId]
}

export function resetAnnouncedAgentNotificationIdsForTest(): void {
  announcedNotificationByPaneKey.clear()
}
