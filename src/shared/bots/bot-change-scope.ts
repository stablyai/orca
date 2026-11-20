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

/** Changes that go out in one quiet window, each kind keeping its own bots (null: every bot). A change
 *  naming no kinds is held under ANY_KIND. */
export type PendingBotChanges = Map<BotChangeKind | typeof ANY_KIND, Set<string> | null>

export function addBotChange(pending: PendingBotChanges, scope: BotChangeScope): void {
  const kinds: readonly (BotChangeKind | typeof ANY_KIND)[] =
    scope.kinds && scope.kinds.length > 0 ? scope.kinds : [ANY_KIND]
  for (const kind of kinds) {
    const bots = pending.get(kind)
    if (!scope.botIds) {
      pending.set(kind, null)
    } else if (bots === undefined) {
      pending.set(kind, new Set(scope.botIds))
    } else if (bots !== null) {
      scope.botIds.forEach((id) => bots.add(id))
    }
  }
}

/** The window's one notice. Its joined `botIds` and `kinds` are what an older reader sees; `kindBots`
 *  keeps an unscoped change of one kind (an automation run) from sending another kind's change (a
 *  worker's) to every bot's readers. */
export function botChangeNotice(pending: PendingBotChanges): BotChangeScope {
  const entries = [...pending]
  const allScoped = entries.every(([, bots]) => bots !== null)
  const botIds = allScoped ? [...new Set(entries.flatMap(([, bots]) => [...(bots ?? [])]))] : null
  if (pending.has(ANY_KIND)) {
    return botIds ? { botIds } : {}
  }
  const kinds = entries.map(([kind]) => kind).filter((kind) => kind !== ANY_KIND)
  const scoped = entries.flatMap(([kind, bots]) =>
    kind !== ANY_KIND && bots ? [[kind, [...bots]] as const] : []
  )
  const sameBots = allScoped && scoped.every(([, bots]) => bots.length === botIds?.length)
  return {
    ...(botIds ? { botIds } : {}),
    kinds,
    ...(sameBots || scoped.length === 0 ? {} : { kindBots: Object.fromEntries(scoped) })
  }
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
  const kindBots = 'kindBots' in event ? readKindBots(event.kindBots) : undefined
  const needsYou = 'needsYou' in event ? readBotNeedsYouCounts(event.needsYou) : undefined
  return botIds || kinds
    ? {
        ...(botIds ? { botIds } : {}),
        ...(kinds ? { kinds } : {}),
        ...(kindBots ? { kindBots } : {}),
        ...(needsYou ? { needsYou } : {})
      }
    : undefined
}

function readKindBots(value: unknown): BotChangeScope['kindBots'] {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const out: Partial<Record<string, string[]>> = {}
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
