// OWNER-TRANSFER notices this desktop shows: the previous owner's (kept by the control plane, one
// per hand-off, until they dismiss it or 90 days pass) and the new owner's (worked out here from
// the team's workspace list and shown once per hand-off).
import { useSyncExternalStore } from 'react'
import type { OwnerChangeNotice } from '../../../../shared/cloud-workspaces/owner-change-wire'
import type { CloudWorkspaceIdentity } from './cloud-workspace-identity'

/** The same 90 days the control plane keeps a previous owner's notice. */
export const OWNER_CHANGE_NOTICE_MAX_AGE_MS = 90 * 24 * 60 * 60_000

type State = { accountKey: string | null; notices: readonly OwnerChangeNotice[] }

let state: State = { accountKey: null, notices: [] }
const listeners = new Set<() => void>()

function set(next: State): void {
  state = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Your notices as a previous owner, for the account they were read for. */
export function usePreviousOwnerNotices(accountKey: string | null): readonly OwnerChangeNotice[] {
  const current = useSyncExternalStore(subscribe, () => state)
  return accountKey && current.accountKey === accountKey ? current.notices : EMPTY
}
const EMPTY: readonly OwnerChangeNotice[] = []

/** Re-reads them. A failed read keeps what was shown (a blip must not take a notice down). */
export async function refreshPreviousOwnerNotices(accountKey: string | null): Promise<void> {
  if (!accountKey) {
    set({ accountKey: null, notices: [] })
    return
  }
  if (state.accountKey !== accountKey) {
    set({ accountKey, notices: [] })
  }
  const result = await window.api.cloudWorkspaces.ownerNotices().catch(() => null)
  if (result?.ok && state.accountKey === accountKey) {
    set({ accountKey, notices: result.value })
  }
}

/** Re-reads for whichever account is showing (after you hand over a workspace of your own). */
export function refreshPreviousOwnerNoticesNow(): void {
  void refreshPreviousOwnerNotices(state.accountKey)
}

/** Takes it down at once and tells the control plane, which then stops listing it. */
export function dismissPreviousOwnerNotice(id: string): void {
  set({ ...state, notices: state.notices.filter((notice) => notice.id !== id) })
  void window.api.cloudWorkspaces.dismissOwnerNotice(id).catch(() => undefined)
}

export type NewOwnerWorkspace = { sandboxId: string; transferredAt: number; title: string | null }

function newOwnerSeenKey(sandboxId: string, transferredAt: number): string {
  return `orca.ownerChange.newOwnerSeen:${sandboxId}:${transferredAt}`
}

function hasSeen(storage: Pick<Storage, 'getItem'> | null, key: string): boolean {
  try {
    return storage?.getItem(key) === '1'
  } catch {
    // Private mode: showing it again is the lesser problem.
    return false
  }
}

/** Once per hand-off: closing the notice (or making the change yourself) records it. */
export function markNewOwnerNoticeSeen(
  storage: Pick<Storage, 'setItem'> | null,
  sandboxId: string,
  transferredAt: number
): void {
  try {
    storage?.setItem(newOwnerSeenKey(sandboxId, transferredAt), '1')
  } catch {
    // A full quota: it shows again next launch.
  }
}

/**
 * Workspaces that were handed to you and that you have not been told about yet. One made from a
 * handed-over workspace carries the same mark but was never handed over itself (it was created
 * after the hand-off), so it gets the chip and no notice.
 */
export function newOwnerWorkspaces(
  bySandbox: ReadonlyMap<string, CloudWorkspaceIdentity>,
  selfId: string | null,
  now: number,
  storage: Pick<Storage, 'getItem'> | null
): NewOwnerWorkspace[] {
  if (!selfId) {
    return []
  }
  const found: NewOwnerWorkspace[] = []
  for (const [sandboxId, identity] of bySandbox) {
    const transferredAt = identity.ownershipTransferredAt
    if (
      identity.ownerUserId === selfId &&
      transferredAt != null &&
      identity.createdAt !== undefined &&
      identity.createdAt < transferredAt &&
      now - transferredAt < OWNER_CHANGE_NOTICE_MAX_AGE_MS &&
      !hasSeen(storage, newOwnerSeenKey(sandboxId, transferredAt))
    ) {
      found.push({ sandboxId, transferredAt, title: identity.title })
    }
  }
  return found.sort((a, b) => a.transferredAt - b.transferredAt)
}

/** Test-only. */
export function resetOwnerChangeNoticesForTests(): void {
  state = { accountKey: null, notices: [] }
  listeners.clear()
}
