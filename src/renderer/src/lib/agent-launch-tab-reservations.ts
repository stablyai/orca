/**
 * Where a host-created agent tab goes, recorded by the caller before it asks the host to launch.
 *
 * The host creates the tab and knows nothing about placement: which tab group the user launched
 * from, and that the tab takes focus. The caller mints every id the tab can arrive under (the
 * terminal's `paneKey` tab, the chat's session tab) and records one placement under all of them;
 * the terminal reveal and the chat mirror each read it by the id they see. Placement never crosses
 * the wire.
 *
 * Renderer memory only, and every entry dies: the reveal consumes it, the caller releases it once
 * the launch settles either way, and an entry nobody consumed or released expires. A window reload
 * drops all of them, and a reveal that finds none uses the default placement.
 */

/** Longer than the launch's readiness budget plus spawn, so a slow but live launch keeps its entry. */
export const AGENT_LAUNCH_TAB_RESERVATION_TTL_MS = 120_000

/** The tab a reveal created, and whether the user was still on its workspace to be shown it. */
export type AgentLaunchTabReveal = { tabId: string; leafId: string | null; inView: boolean }

/**
 * A reserved tab takes focus as it appears, as a launch from a button does, while the user is still
 * on its workspace; otherwise it becomes its group's tab without switching workspaces.
 */
export type AgentLaunchTabReservation = {
  worktreeId: string
  groupId?: string
  /** Runs once the tab exists, before the launch reply arrives. */
  onRevealed?: (reveal: AgentLaunchTabReveal) => void
}

type Entry = { reservation: AgentLaunchTabReservation; expiresAt: number }

const reservations = new Map<string, Entry>()

function sweepExpired(now: number): void {
  for (const [tabId, entry] of reservations) {
    if (entry.expiresAt <= now) {
      reservations.delete(tabId)
    }
  }
}

function deleteEntry(entry: Entry): void {
  for (const [tabId, candidate] of reservations) {
    if (candidate === entry) {
      reservations.delete(tabId)
    }
  }
}

/**
 * Records the placement under every tab id the launch may arrive as, and returns its release,
 * which is safe to call after the reveal took it.
 */
export function reserveAgentLaunchTab(
  tabIds: string | readonly string[],
  reservation: AgentLaunchTabReservation,
  now = Date.now()
): () => void {
  sweepExpired(now)
  const entry: Entry = { reservation, expiresAt: now + AGENT_LAUNCH_TAB_RESERVATION_TTL_MS }
  for (const tabId of typeof tabIds === 'string' ? [tabIds] : tabIds) {
    reservations.set(tabId, entry)
  }
  return () => deleteEntry(entry)
}

/**
 * The reservation for a tab the host is revealing, if one is live for that workspace.
 *
 * Claimed, not consumed: a focused reveal activates the workspace before it creates the tab, and that
 * activation reconciles tabs, which would drop the reserved empty group if the reservation were
 * already gone. The reveal consumes it once the tab exists.
 */
export function claimAgentLaunchTabReservation(
  tabId: string,
  worktreeId: string,
  now = Date.now()
): { reservation: AgentLaunchTabReservation; consume: () => void } | null {
  sweepExpired(now)
  const entry = reservations.get(tabId)
  if (!entry || entry.reservation.worktreeId !== worktreeId) {
    return null
  }
  return { reservation: entry.reservation, consume: () => deleteEntry(entry) }
}

/**
 * Tab groups a live launch will place its tab into. Reconciliation drops empty groups, and the
 * group a user launched from is often an empty split that must survive until its tab arrives; it is
 * released with the reservation, so a launch that never reveals leaves nothing behind.
 */
export function agentLaunchReservedGroupIds(
  worktreeId: string,
  now = Date.now()
): ReadonlySet<string> {
  sweepExpired(now)
  const groupIds = new Set<string>()
  for (const { reservation } of new Set(reservations.values())) {
    if (reservation.worktreeId === worktreeId && reservation.groupId) {
      groupIds.add(reservation.groupId)
    }
  }
  return groupIds
}

export function agentLaunchTabReservationCountForTests(): number {
  return new Set(reservations.values()).size
}
