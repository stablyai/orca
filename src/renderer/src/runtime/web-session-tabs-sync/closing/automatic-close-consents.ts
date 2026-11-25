// Orca closes a request chat's tab on its own in two steps: this window consents (nothing is closed
// then), the host hides the chat, and the window drops the tab when it adopts the host's snapshot.
// The decision is made again at that removal: if someone brought the tab forward, focused, pinned or
// reopened it since consenting, the window keeps it and asks the host to show the same chat again.
import type { Tab, TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'

/** A consent that no adoption followed within this long decides nothing more. */
export const AUTOMATIC_CLOSE_CONSENT_TTL_MS = 5 * 60_000

type Consent = { consentedAt: number; revealAsked: boolean }

const consents = new Map<string, Consent>()

const keyOf = (worktreeId: string, sessionId: string) => `${worktreeId}\u0000${sessionId}`

export function recordAutomaticCloseConsent(
  worktreeId: string,
  sessionId: string,
  at: number = Date.now()
): void {
  consents.set(keyOf(worktreeId, sessionId), { consentedAt: at, revealAsked: false })
}

/** The host lists the chat again: nothing is being removed. */
export function forgetAutomaticCloseConsent(worktreeId: string, sessionId: string): void {
  if (consents.size > 0) {
    consents.delete(keyOf(worktreeId, sessionId))
  }
}

export function hasAutomaticCloseConsents(): boolean {
  return consents.size > 0
}

/** At adoption of a snapshot that no longer lists `tab`'s chat: true keeps the tab, because a person
 *  used it after this window consented; the host is asked once to show the chat again. */
export function automaticCloseKeepsAtAdoption(
  state: { groupsByWorktree?: Record<string, readonly Pick<TabGroup, 'activeTabId'>[]> },
  worktreeId: string,
  tab: Pick<Tab, 'id' | 'entityId' | 'isPinned' | 'lastFocusedAt' | 'createdAt'>,
  reveal: (sessionId: string) => void,
  now: number = Date.now()
): boolean {
  const key = keyOf(worktreeId, tab.entityId)
  const consent = consents.get(key)
  if (!consent) {
    return false
  }
  if (now - consent.consentedAt > AUTOMATIC_CLOSE_CONSENT_TTL_MS) {
    consents.delete(key)
    return false
  }
  const inFront = (state.groupsByWorktree?.[worktreeId] ?? []).some(
    (group) => group.activeTabId === tab.id
  )
  const usedSince =
    inFront ||
    tab.isPinned === true ||
    (tab.lastFocusedAt ?? 0) > consent.consentedAt ||
    tab.createdAt > consent.consentedAt
  if (!usedSince) {
    consents.delete(key)
    return false
  }
  if (!consent.revealAsked) {
    consent.revealAsked = true
    reveal(tab.entityId)
  }
  return true
}

/** Tests only. */
export function resetAutomaticCloseConsents(): void {
  consents.clear()
}
