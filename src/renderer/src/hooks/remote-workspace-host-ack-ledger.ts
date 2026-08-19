import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { splitWorktreeId } from '../../../shared/worktree/id'

/**
 * What each CLIENT of a direct-SSH host has published about that host's tab list.
 *
 * There is no host authority to appeal to. `workspace.patch` is `{kind:'replace-session'}` over a
 * namespace shared by every client of the host (src/relay/workspace-session-handler.ts:127-160), the
 * relay stores the blob opaquely and only bumps a CAS counter, and each client exports just the
 * worktrees whose repo it holds (src/main/ipc/remote-workspace.ts:59-70). So "the host stopped
 * listing this tab" is really "the client that wrote last did not list it", and that is ambiguous in
 * exactly the way the merge's comment describes: it can mean the writer closed the tab, or that the
 * writer never knew about it.
 *
 * The two are byte-identical on the wire. A snapshot carries `revision`, but the relay enforces
 * `baseRevision === current.revision` and publishes `current.revision + 1`, so the base is always
 * `revision - 1` and says nothing; worse, the base is the writer's MAIN-process cache, which
 * `handleRemoteWorkspaceNotification` updates synchronously while its renderer apply still lags
 * (src/main/ipc/remote-workspace.ts:84). A stale writer therefore publishes a genuinely older tab
 * list at a genuinely newer revision, and no field on `RemoteWorkspaceSnapshot` distinguishes that
 * from a close.
 *
 * What IS decidable is who wrote it: `workspace.changed` carries `sourceClientId`, minted per
 * process by the writing client and echoed by the relay since remote workspaces shipped. So this
 * ledger records, per (target, publisher), the tab ids that publisher has itself listed. A tab may
 * then be retired only when the SAME publisher that once listed it stops listing it — a retraction,
 * which is positive evidence that the writer knew the tab and dropped it, rather than absence, which
 * is not evidence at all. A publisher that never listed the tab can rewrite the namespace as often
 * as it likes and never retire it.
 *
 * Consequences, all in the safe direction:
 * - a pulled snapshot (`workspace.get`) has no publisher, so it can never retire anything;
 * - a relay old enough to omit `sourceClientId` degrades to today's preserve-forever behaviour;
 * - `CLIENT_ID` is per-process, so a peer restart forgets its listings and retirement waits for it
 *   to publish again.
 *
 * The cost is a false negative: a peer that applies a tab and closes it without ever publishing it
 * in between is not retractable, so the tab is preserved, re-uploaded and resurrected once before
 * the peer's next publish makes it retractable. Closing that needs the closing client to publish the
 * removal (a tombstone in `RemoteWorkspaceSession`), which is a change to what the host holds.
 *
 * Client-local by construction: `revision`, `namespace` and `sourceClientId` are already on the v1
 * wire types, so nothing new crosses to the host and an old host is unaffected.
 */
export type RemoteWorkspaceHostAckedTab = {
  /** Why: the path the publisher listed it under. An omission is only evidence while it still describes that path. */
  worktreePath: string
}

/** One publisher's most recent listing, plus the ids it has dropped but not yet had retired. */
export type RemoteWorkspacePublisherListing = {
  revision: number
  tabsById: Record<string, RemoteWorkspaceHostAckedTab>
}

export type RemoteWorkspaceHostAck = {
  /** Why: the namespace is derived from host/port/user, so it changes when a target is repointed. Listings from a different namespace must never authorize a retirement. */
  namespace: string
  listingsByPublisherId: Record<string, RemoteWorkspacePublisherListing>
}

export type RemoteWorkspaceHostAckLedger = Record<string, RemoteWorkspaceHostAck>

/** Why bounded: publisher ids are per-process, so a long-lived session would otherwise accumulate one entry per peer launch. */
const MAX_TRACKED_PUBLISHERS = 8

function listedPathsIn(snapshot: RemoteWorkspaceSnapshot): Set<string> {
  return new Set(Object.keys(snapshot.session.tabsByWorktreePath ?? {}))
}

/**
 * Tab ids this client holds under the given worktree paths.
 *
 * Scoped by path rather than flattening every worktree because `tabsByWorktree` spans every repo on
 * every host, and the only ids this ledger can answer for are the ones its own target listed.
 */
function localTabIdsUnderPaths(
  localTabsByWorktree: Readonly<Record<string, readonly TerminalTab[]>>,
  worktreePaths: ReadonlySet<string>
): Set<string> {
  const tabIds = new Set<string>()
  // Why keys and not entries: the tab arrays of unrelated worktrees are never even dereferenced.
  for (const worktreeId of Object.keys(localTabsByWorktree)) {
    const worktreePath = splitWorktreeId(worktreeId)?.worktreePath
    if (!worktreePath || !worktreePaths.has(worktreePath)) {
      continue
    }
    for (const tab of localTabsByWorktree[worktreeId] ?? []) {
      tabIds.add(tab.id)
    }
  }
  return tabIds
}

/**
 * Carries forward the ids this publisher listed before but dropped now.
 *
 * Kept as standing candidates so an omission this client could not act on yet — the worktree was not
 * in the target scope at the time, or the catalog had not resolved its path — delays retirement
 * instead of disabling it for that id forever. Only while the publisher still describes the path the
 * id was listed under and this client still holds the tab, so an old retraction cannot outlive the
 * evidence for it.
 */
function standingCandidates(
  previous: RemoteWorkspacePublisherListing | undefined,
  listedPaths: ReadonlySet<string>,
  localTabsByWorktree: Readonly<Record<string, readonly TerminalTab[]>>
): Record<string, RemoteWorkspaceHostAckedTab> {
  const carried: Record<string, RemoteWorkspaceHostAckedTab> = {}
  const standing = Object.entries(previous?.tabsById ?? {}).filter(([, listed]) =>
    listedPaths.has(listed.worktreePath)
  )
  if (standing.length === 0) {
    // Why deferred: with nothing standing — the ordinary listing — no worktree is scanned at all.
    return carried
  }
  const heldTabIds = localTabIdsUnderPaths(
    localTabsByWorktree,
    new Set(standing.map(([, listed]) => listed.worktreePath))
  )
  for (const [tabId, listed] of standing) {
    if (heldTabIds.has(tabId)) {
      carried[tabId] = listed
    }
  }
  return carried
}

function withPublisherCap(
  listings: Record<string, RemoteWorkspacePublisherListing>
): Record<string, RemoteWorkspacePublisherListing> {
  const publisherIds = Object.keys(listings)
  if (publisherIds.length <= MAX_TRACKED_PUBLISHERS) {
    return listings
  }
  const kept = publisherIds
    .sort((a, b) => listings[b].revision - listings[a].revision)
    .slice(0, MAX_TRACKED_PUBLISHERS)
  return Object.fromEntries(kept.map((publisherId) => [publisherId, listings[publisherId]]))
}

/**
 * Folds a host listing into the ledger, attributed to the client that published it.
 *
 * `publisherId` is `workspace.changed`'s `sourceClientId`. A listing with no publisher — a
 * `workspace.get` pull, or this client's own push result — still resets the ledger when the
 * namespace changes, but records nothing: an unattributed listing can never support a retraction.
 *
 * Monotonic per publisher: an arrival at or below that publisher's recorded revision is dropped.
 * Snapshot applies are not revision-fenced (direct-ssh-reconnect-tokens.ts:73-84), so without this a
 * late older listing would become the publisher's "latest" and silently discard what it listed in
 * between. The documented relay-reset degradation follows: a reset moves the line backwards on
 * purpose, and retirement stays off until the new line passes the old watermark.
 *
 * `localTabsByWorktree` is read only under the paths this target's own listings named, so a listing
 * for one host never walks another host's repos.
 */
export function recordRemoteWorkspaceHostAck(
  ledger: RemoteWorkspaceHostAckLedger,
  targetId: string,
  snapshot: RemoteWorkspaceSnapshot,
  localTabsByWorktree: Readonly<Record<string, readonly TerminalTab[]>>,
  publisherId: string | null | undefined
): RemoteWorkspaceHostAckLedger {
  const previous = ledger[targetId]
  const sameLine = previous?.namespace === snapshot.namespace
  if (!publisherId) {
    return sameLine
      ? ledger
      : { ...ledger, [targetId]: { namespace: snapshot.namespace, listingsByPublisherId: {} } }
  }
  const previousListing = sameLine ? previous.listingsByPublisherId[publisherId] : undefined
  if (previousListing && snapshot.revision <= previousListing.revision) {
    return ledger
  }
  const listedPaths = listedPathsIn(snapshot)
  const tabsById = standingCandidates(previousListing, listedPaths, localTabsByWorktree)
  for (const [worktreePath, tabs] of Object.entries(snapshot.session.tabsByWorktreePath ?? {})) {
    for (const tab of tabs) {
      tabsById[tab.id] = { worktreePath }
    }
  }
  return {
    ...ledger,
    [targetId]: {
      namespace: snapshot.namespace,
      listingsByPublisherId: withPublisherCap({
        ...(sameLine ? previous.listingsByPublisherId : {}),
        [publisherId]: { revision: snapshot.revision, tabsById }
      })
    }
  }
}

export function clearRemoteWorkspaceHostAck(
  ledger: RemoteWorkspaceHostAckLedger,
  targetId: string
): RemoteWorkspaceHostAckLedger {
  if (!Object.hasOwn(ledger, targetId)) {
    return ledger
  }
  const next = { ...ledger }
  delete next[targetId]
  return next
}

type HostRetiredTabSelection = {
  ledger: RemoteWorkspaceHostAckLedger
  targetId: string
  snapshot: RemoteWorkspaceSnapshot
  /** `workspace.changed`'s sourceClientId; absent for pulls, which can never retire anything. */
  publisherId: string | null | undefined
  localTabsByWorktree: Record<string, TerminalTab[]>
  worktreeIds: ReadonlySet<string>
}

/**
 * Local tab ids the publisher of this snapshot RETRACTED, grouped by the worktree that holds them.
 *
 * Grouped, and each (worktree, tab) copy judged on its own listing, so an id held under two worktree
 * ids can only lose the copy under the path it was listed at.
 *
 * Every other shape of absence falls through to the merge's preserve rule:
 *
 * - the snapshot has no publisher, or one that never listed this id — absence by a client that does
 *   not know the tab is not evidence about the tab. This is what makes a stale peer harmless: its
 *   main-process cache CAS'd on a revision its renderer has not applied, so it republishes an older
 *   tab list at a newer revision, and no id it never listed can be retracted by it;
 * - a listing from another target or namespace — a repointed target has an unrelated revision line;
 * - a revision at or below that publisher's watermark — out-of-order arrivals and relay resets prove
 *   nothing;
 * - the snapshot carries no entry for the worktree path the id was listed under — a publisher whose
 *   repo set does not include that worktree strips the key on every push, so its listing is silent
 *   about those tabs rather than empty.
 *
 * That list is exhaustive on purpose. Every LOCAL-state veto tried here was universally satisfied and
 * left retirement inert, because the direct-SSH reconnect pass (retryDirectSshTargetPanes, run on
 * every connected-authority transition AND at the end of every snapshot apply) touches every tab of
 * the target: `pendingActivationSpawn` is stamped on every hydrated row, `directSshPaneRetryByTabId`
 * gains an entry per tab (and `directSshLivePtyBindingByTabId` once each pane settles), and
 * `tab.generation` is bumped past whatever any publisher listed. None of them is evidence anyway —
 * they describe this client's pty plumbing, not whether the publisher knew the tab and dropped it,
 * which is the only question that separates "the host retired this" from "a peer does not know
 * about it".
 *
 * `generation` in particular is NOT comparable across publishers: each client bumps its own copy on
 * every local pane retry without the peer ever seeing it, so `local > listed` says nothing about tab
 * identity. Tab ids carry that on their own — they are UUIDs and `createTab` mints a fresh one rather
 * than accept a colliding hint (terminals.ts:1318-1327) — so an id the publisher listed and this
 * client still holds is the same tab, and the publisher's retraction is about exactly it.
 */
export function selectHostRetiredTabIdsByWorktree({
  ledger,
  targetId,
  snapshot,
  publisherId,
  localTabsByWorktree,
  worktreeIds
}: HostRetiredTabSelection): Map<string, Set<string>> {
  const retiredByWorktreeId = new Map<string, Set<string>>()
  const entry = ledger[targetId]
  if (!publisherId || !entry || entry.namespace !== snapshot.namespace) {
    return retiredByWorktreeId
  }
  const listing = entry.listingsByPublisherId[publisherId]
  if (!listing || snapshot.revision <= listing.revision) {
    return retiredByWorktreeId
  }
  const listedPaths = listedPathsIn(snapshot)
  const publishedTabIds = new Set(
    Object.values(snapshot.session.tabsByWorktreePath ?? {}).flatMap((tabs) =>
      tabs.map((tab) => tab.id)
    )
  )
  for (const worktreeId of worktreeIds) {
    const worktreePath = splitWorktreeId(worktreeId)?.worktreePath
    if (!worktreePath || !listedPaths.has(worktreePath)) {
      continue
    }
    const retired = new Set<string>()
    for (const tab of localTabsByWorktree[worktreeId] ?? []) {
      const listed = listing.tabsById[tab.id]
      if (!listed || listed.worktreePath !== worktreePath || publishedTabIds.has(tab.id)) {
        continue
      }
      retired.add(tab.id)
    }
    if (retired.size > 0) {
      retiredByWorktreeId.set(worktreeId, retired)
    }
  }
  return retiredByWorktreeId
}
