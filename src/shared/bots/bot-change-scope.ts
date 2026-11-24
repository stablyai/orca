// What one `botsChanged` is about, so each reader re-reads only for its own bot and its own kind of change.

/** What changed:
 *  - `bot`: a bot itself (created, edited, removed);
 *  - `chats`: its chat records; `status`: a phase of one of its panes; `workers`: its Dispatches or worktrees;
 *  - `automations`: its automations or their runs; `threads`: its conversation links; `lookAround`: its Up next;
 *  - `groups`: a group room; `access`: the host's access requests; `settings`: tools, sign-ins, connectors;
 *  - `items`: its items (what it is doing for its owner and needs from them). */
export const BOT_CHANGE_KINDS = [
  'bot',
  'chats',
  'status',
  'workers',
  'automations',
  'threads',
  'lookAround',
  'groups',
  'access',
  'settings',
  'items'
] as const

export type BotChangeKind = (typeof BOT_CHANGE_KINDS)[number]

/** Every bot's Needs you items that aren't stale, as the host counted them at `at` (its clock, so a
 *  later count wins); the next counted one goes stale in `staleInMs`. */
export type BotNeedsYouCounts = {
  counts: Readonly<Record<string, number>>
  at: number
  staleInMs?: number
}

/** A notice's scope. No `botIds`: every bot (an older host says nothing more). No `kinds`: anything.
 *  `kindBots` names each listed kind's own bots when they differ (a kind it leaves out: every bot); an
 *  older reader ignores it and reads the joined `botIds`. An `items` notice carries the host's
 *  `needsYou`, so a window shows the counts without a list read. */
export type BotChangeScope = {
  botIds?: readonly string[]
  kinds?: readonly BotChangeKind[]
  kindBots?: Readonly<Partial<Record<BotChangeKind, readonly string[]>>>
  needsYou?: BotNeedsYouCounts
  /** An `items` change's items, by bot: a bot listed here had only these change, so its list reads
   *  just them. A bot left out (and an older host's notice) re-reads whole. */
  itemUids?: Readonly<Record<string, readonly string[]>>
  /** The host reads a list's items by uid, so a `workers` change can read just the loaded items that
   *  link a worker. Absent: an older host, whose lists read whole. */
  namesItems?: true
  /** A `groups` change's rooms, by group id: an open room re-reads only when its group is named. Absent
   *  (and an older host's notice): every room re-reads. */
  groupIds?: readonly string[]
  /** `groupIds` as a peer's notice carried it, unread: only an open room reads it (botGroupRoomConcerned),
   *  so a reader that wants no room never walks the list. */
  receivedGroupIds?: readonly unknown[]
}

/** The notice of these changed items, by bot; null for none. */
export function botItemsChangeScope(
  items: readonly { uid: string; ownerBotId: string }[]
): BotChangeScope | null {
  const itemUids: Record<string, string[]> = {}
  for (const { uid, ownerBotId } of items) {
    ;(itemUids[ownerBotId] ??= []).push(uid)
  }
  const botIds = Object.keys(itemUids)
  if (botIds.length === 0) {
    return null
  }
  return { botIds, kinds: ['items'], itemUids }
}

/** What a reader re-reads for: its bot (absent for a host-wide reader) and the kinds it shows. */
export type BotChangeInterest = {
  botId?: string
  kinds: readonly BotChangeKind[]
}

/** A bot's work: its chats tree and Activity. */
export const BOT_WORK_KINDS: readonly BotChangeKind[] = [
  'bot',
  'chats',
  'status',
  'workers',
  'automations',
  'threads',
  'lookAround'
]

/** Every view of one bot: its work, and its tools and sign-ins. */
export const BOT_VIEW_KINDS: readonly BotChangeKind[] = [...BOT_WORK_KINDS, 'settings']

/** Whether a notice can change what the reader shows. A kind this build does not know counts, so a
 *  newer host's notice never goes unread. */
export function botChangeConcerns(scope: BotChangeScope | undefined, interest: BotChangeInterest) {
  if (!scope) {
    return true
  }
  const known = new Set<string>(BOT_CHANGE_KINDS)
  const kinds =
    scope.kinds && scope.kinds.length > 0
      ? scope.kinds.filter((kind) => !known.has(kind) || interest.kinds.includes(kind))
      : null
  if (kinds?.length === 0) {
    return false
  }
  // A host-wide reader shows every bot, so a bot-scoped notice of its kind concerns it.
  const { botId } = interest
  if (!botId) {
    return true
  }
  const botsOf = (kind: BotChangeKind): readonly string[] | undefined =>
    scope.kindBots ? scope.kindBots[kind] : scope.botIds
  return kinds
    ? kinds.some((kind) => botsOf(kind)?.includes(botId) ?? true)
    : (scope.botIds?.includes(botId) ?? true)
}

/** The bots a notice names for any of these kinds; null when one of them covers every bot. */
export function botChangeBotIds(
  scope: BotChangeScope | undefined,
  kinds: readonly BotChangeKind[]
): readonly string[] | null {
  if (!scope?.kindBots || !scope.kinds?.length) {
    return scope?.botIds ?? null
  }
  const known = new Set<string>(BOT_CHANGE_KINDS)
  const ids = new Set<string>()
  for (const kind of scope.kinds) {
    if (known.has(kind) && !kinds.includes(kind)) {
      continue
    }
    const bots = scope.kindBots[kind]
    if (!bots) {
      return null
    }
    bots.forEach((id) => ids.add(id))
  }
  return [...ids]
}

const ANY_KIND = '*'

/** Changes that go out in one quiet window: each kind keeping its own bots (null: every bot), a change
 *  naming no kinds held under ANY_KIND; and each bot's changed items (null once a change of its items
 *  didn't name them, or named too many to read one by one). */
export type PendingBotChanges = {
  kinds: Map<BotChangeKind | typeof ANY_KIND, Set<string> | null>
  itemUids: Map<string, Set<string> | null>
  /** The rooms a `groups` change named; null once one named none (every room), absent before any. */
  groupIds?: Set<string> | null
}

export function pendingBotChanges(): PendingBotChanges {
  return { kinds: new Map(), itemUids: new Map() }
}

/** The most items a notice names for one bot; more re-read the bot's list whole. */
export const BOT_CHANGE_ITEM_UIDS_MAX = 100

export function addBotChange(pending: PendingBotChanges, scope: BotChangeScope): void {
  const kinds: readonly (BotChangeKind | typeof ANY_KIND)[] =
    scope.kinds && scope.kinds.length > 0 ? scope.kinds : [ANY_KIND]
  if (kinds.includes('groups') || kinds.includes(ANY_KIND)) {
    // A change naming no room (no list, or an empty one) reaches every room.
    if (!scope.groupIds?.length || pending.groupIds === null) {
      pending.groupIds = null
    } else {
      pending.groupIds ??= new Set()
      scope.groupIds.forEach((id) => pending.groupIds?.add(id))
    }
  }
  for (const kind of kinds) {
    const bots = pending.kinds.get(kind)
    if (!scope.botIds) {
      pending.kinds.set(kind, null)
    } else if (bots === undefined) {
      pending.kinds.set(kind, new Set(scope.botIds))
    } else if (bots !== null) {
      scope.botIds.forEach((id) => bots.add(id))
    }
  }
  if (!kinds.includes('items') || !scope.botIds) {
    return
  }
  for (const botId of scope.botIds) {
    const named = scope.itemUids?.[botId]
    const uids = pending.itemUids.get(botId)
    if (!named || uids === null) {
      pending.itemUids.set(botId, null)
      continue
    }
    const next = uids ?? new Set<string>()
    named.forEach((uid) => next.add(uid))
    pending.itemUids.set(botId, next.size > BOT_CHANGE_ITEM_UIDS_MAX ? null : next)
  }
}

/** The window's one notice. Its joined `botIds` and `kinds` are what an older reader sees; `kindBots`
 *  keeps an unscoped change of one kind (an automation run) from sending another kind's change (a
 *  worker's) to every bot's readers. */
export function botChangeNotice(pending: PendingBotChanges): BotChangeScope {
  const entries = [...pending.kinds]
  const allScoped = entries.every(([, bots]) => bots !== null)
  const botIds = allScoped ? [...new Set(entries.flatMap(([, bots]) => [...(bots ?? [])]))] : null
  if (pending.kinds.has(ANY_KIND)) {
    return botIds ? { botIds } : {}
  }
  const groupIds = pending.kinds.has('groups') && pending.groupIds ? [...pending.groupIds] : null
  const kinds = entries.map(([kind]) => kind).filter((kind) => kind !== ANY_KIND)
  const scoped = entries.flatMap(([kind, bots]) =>
    kind !== ANY_KIND && bots ? [[kind, [...bots]] as const] : []
  )
  const sameBots = allScoped && scoped.every(([, bots]) => bots.length === botIds?.length)
  // An items change of every bot names none of them.
  const named =
    pending.kinds.get('items') === null
      ? []
      : [...pending.itemUids].flatMap(([botId, uids]) =>
          uids ? [[botId, [...uids]] as const] : []
        )
  return {
    ...(botIds ? { botIds } : {}),
    kinds,
    ...(sameBots || scoped.length === 0 ? {} : { kindBots: Object.fromEntries(scoped) }),
    ...(named.length > 0 ? { itemUids: Object.fromEntries(named) } : {}),
    ...(pending.kinds.has('workers') ? { namesItems: true as const } : {}),
    ...(groupIds ? { groupIds } : {})
  }
}

/** Whether an open room of `groupId` re-reads for this notice: a `groups` change (or one of any or an
 *  unknown kind) that names its group or names none. */
export function botGroupRoomConcerned(scope: BotChangeScope | undefined, groupId: string): boolean {
  const known = new Set<string>(BOT_CHANGE_KINDS)
  const kinds = scope?.kinds ?? []
  // A kind this build does not know counts, as in botChangeConcerns.
  if (kinds.some((kind) => !known.has(kind))) {
    return true
  }
  if (kinds.length > 0 && !kinds.includes('groups')) {
    return false
  }
  const listed = scope?.groupIds ?? scope?.receivedGroupIds
  // A list with no room in it names none, so every room re-reads.
  const rooms = listed ? namedRooms(listed) : null
  return rooms && rooms.size > 0 ? rooms.has(groupId) : true
}

// Each notice's rooms as a set, built once however many open rooms ask.
const roomSets = new WeakMap<readonly unknown[], ReadonlySet<string>>()

function namedRooms(groupIds: readonly unknown[]): ReadonlySet<string> {
  let rooms = roomSets.get(groupIds)
  if (!rooms) {
    rooms = new Set(groupIds.filter((id): id is string => typeof id === 'string'))
    roomSets.set(groupIds, rooms)
  }
  return rooms
}

/** The scope a runtime event carries, read loosely (a peer of another version may send anything). */
export function readBotChangeScope(event: unknown): BotChangeScope | undefined {
  if (!event || typeof event !== 'object') {
    return undefined
  }
  const botIds =
    'botIds' in event && Array.isArray(event.botIds)
      ? event.botIds.filter((id): id is string => typeof id === 'string')
      : undefined
  const kinds =
    'kinds' in event && Array.isArray(event.kinds)
      ? event.kinds.filter((kind): kind is BotChangeKind => typeof kind === 'string')
      : undefined
  const kindBots = 'kindBots' in event ? readStringLists(event.kindBots) : undefined
  const needsYou = 'needsYou' in event ? readBotNeedsYouCounts(event.needsYou) : undefined
  // Kept as sent: only an open room walks it, once per notice.
  // A notice read once already (the preload's, a paired host's) carries it as `receivedGroupIds`.
  const receivedGroupIds: readonly unknown[] | undefined =
    'groupIds' in event && Array.isArray(event.groupIds)
      ? event.groupIds
      : 'receivedGroupIds' in event && Array.isArray(event.receivedGroupIds)
        ? event.receivedGroupIds
        : undefined
  return botIds || kinds
    ? {
        ...(botIds ? { botIds } : {}),
        ...(kinds ? { kinds } : {}),
        ...(kindBots ? { kindBots } : {}),
        ...(needsYou ? { needsYou } : {}),
        ...(receivedGroupIds ? { receivedGroupIds } : {})
      }
    : undefined
}

/** `readBotChangeScope` with the items it names (`itemUids`, `namesItems`), for Items lists that read
 *  just those; kept apart so readers that don't stay as small as they were. */
export function readBotChangeScopeWithItems(event: unknown): BotChangeScope | undefined {
  const scope = readBotChangeScope(event)
  if (!scope || !event || typeof event !== 'object') {
    return scope
  }
  const itemUids = 'itemUids' in event ? readStringLists(event.itemUids) : undefined
  return {
    ...scope,
    ...(itemUids ? { itemUids } : {}),
    ...('namesItems' in event && event.namesItems === true ? { namesItems: true as const } : {})
  }
}

/** A record of string lists (`kindBots`, `itemUids`), read loosely. */
function readStringLists(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const out: Record<string, string[]> = {}
  for (const [kind, bots] of Object.entries(value)) {
    if (Array.isArray(bots)) {
      out[kind] = bots.filter((id): id is string => typeof id === 'string')
    }
  }
  return out
}

function readBotNeedsYouCounts(value: unknown): BotNeedsYouCounts | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('at' in value) ||
    typeof value.at !== 'number' ||
    !('counts' in value) ||
    !value.counts ||
    typeof value.counts !== 'object'
  ) {
    return undefined
  }
  const counts: Record<string, number> = {}
  for (const [botId, count] of Object.entries(value.counts)) {
    if (typeof count === 'number') {
      counts[botId] = count
    }
  }
  const staleInMs =
    'staleInMs' in value && typeof value.staleInMs === 'number' ? value.staleInMs : undefined
  return { counts, at: value.at, ...(staleInMs !== undefined ? { staleInMs } : {}) }
}
