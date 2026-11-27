import type { WorkspaceViewChoice } from '../workspace-view/workspace-view-options'

// Ids and meanings match the projects' Sort by; desktop and phone localize the labels.
export const BOT_SIDEBAR_SORT_CHOICES = [
  { id: 'manual', label: 'Manual', description: 'Drag bots to arrange them. New bots go on top.' },
  {
    id: 'smart',
    label: 'Agent Activity',
    description: 'Bots that need you, then most recent activity.'
  },
  { id: 'recent', label: 'Recent' },
  { id: 'name', label: 'Name' }
] as const satisfies readonly WorkspaceViewChoice<string>[]

export type BotSidebarSortBy = (typeof BOT_SIDEBAR_SORT_CHOICES)[number]['id']

/** The Bots section's "Bot options": how this computer's bots list, on desktop and on a paired phone. */
export type BotSidebarView = {
  sortBy: BotSidebarSortBy
  hidePausedBots: boolean
  tagFilter?: string[]
  /** A bot's worker lines with nothing running drop off, as the projects' Hide sleeping. */
  hideSleepingWorkers: boolean
}

export const DEFAULT_BOT_SIDEBAR_VIEW: BotSidebarView = {
  sortBy: 'manual',
  hidePausedBots: false,
  tagFilter: [],
  hideSleepingWorkers: false
}

/** Saved or relayed options, any missing or unknown field at its default. */
export function normalizeBotSidebarView(value: unknown): BotSidebarView {
  const saved: Partial<Record<keyof BotSidebarView, unknown>> =
    typeof value === 'object' && value !== null ? value : {}
  const sortBy = BOT_SIDEBAR_SORT_CHOICES.find((choice) => choice.id === saved.sortBy)?.id
  return {
    sortBy: sortBy ?? DEFAULT_BOT_SIDEBAR_VIEW.sortBy,
    hidePausedBots: saved.hidePausedBots === true,
    tagFilter: Array.isArray(saved.tagFilter)
      ? [
          ...new Set(
            saved.tagFilter.flatMap((tag: unknown) =>
              typeof tag === 'string' && tag ? [tag.toLowerCase()] : []
            )
          )
        ]
      : [],
    hideSleepingWorkers: saved.hideSleepingWorkers === true
  }
}

/** How many options differ from the default, for the button's badge. */
export function countActiveBotSidebarFilters(view: BotSidebarView): number {
  return Number(view.hidePausedBots) + Number(view.hideSleepingWorkers)
}

type TaggedBot = { tags?: readonly string[] }

export const NO_BOT_SIDEBAR_TAGS: ReadonlySet<string> = new Set()
export const botSidebarNameCollator = new Intl.Collator(undefined, { sensitivity: 'base' })

export function botSidebarTags(bots: readonly TaggedBot[]): ReadonlyMap<string, string> {
  const tags = new Map<string, string>()
  for (const bot of bots) {
    for (const tag of bot.tags ?? []) {
      const key = tag.toLowerCase()
      if (!tags.has(key)) {
        tags.set(key, tag)
      }
    }
  }
  return tags
}

export function activeBotSidebarTags(
  selection: readonly string[] | undefined,
  botsOrTags: readonly TaggedBot[] | ReadonlyMap<string, string>
): ReadonlySet<string> {
  if (!selection?.length) {
    return NO_BOT_SIDEBAR_TAGS
  }
  const available = 'has' in botsOrTags ? botsOrTags : botSidebarTags(botsOrTags)
  return new Set(selection.filter((key) => available.has(key)))
}

export type BotSidebarHiddenReason = 'bot-hidden' | 'bot-filtered'

export function botSidebarHiddenReason(
  bot: TaggedBot & { paused: boolean },
  hidePausedBots: boolean,
  activeTags: ReadonlySet<string>
): BotSidebarHiddenReason | null {
  if (hidePausedBots && bot.paused) {
    return 'bot-hidden'
  }
  return activeTags.size > 0 && !bot.tags?.some((tag) => activeTags.has(tag.toLowerCase()))
    ? 'bot-filtered'
    : null
}

type ArrangedEntry =
  | { kind: 'bot'; bot: TaggedBot & { name: string; paused: boolean; createdAt?: unknown } }
  | { kind: 'group'; group: { name: string; createdAt?: unknown } }

export type BotSidebarEntryActivity = {
  /** It or one of its workers waits on the owner. */
  needsYou: boolean
  /** Its newest activity, ms; 0 when never active. */
  activityAt: number
}

/** How recent a row is: its newest activity, else when it was made, since a new home has none yet. */
export function botSidebarEntryRecency(entry: ArrangedEntry, activityAt: number): number {
  const createdAt = entry.kind === 'bot' ? entry.bot.createdAt : entry.group.createdAt
  return typeof createdAt === 'number' && createdAt > activityAt ? createdAt : activityAt
}

/** The Bots section's rows as the options list them; entries come in saved (Manual) order, which breaks ties. */
export function arrangeBotSidebarEntries<E extends ArrangedEntry>(
  entries: readonly E[],
  view: BotSidebarView,
  activityOf: (entry: E) => BotSidebarEntryActivity,
  activeTags: ReadonlySet<string> = NO_BOT_SIDEBAR_TAGS
): E[] {
  // Groups are rooms the owner made on purpose; only bots are filtered.
  const shown = entries.filter(
    (entry) =>
      entry.kind === 'group' ||
      botSidebarHiddenReason(entry.bot, view.hidePausedBots, activeTags) === null
  )
  if (view.sortBy === 'manual') {
    return shown
  }
  const name = (entry: E): string => (entry.kind === 'bot' ? entry.bot.name : entry.group.name)
  if (view.sortBy === 'name') {
    return shown
      .map((entry, index) => ({ entry, index }))
      .sort(
        (left, right) =>
          botSidebarNameCollator.compare(name(left.entry), name(right.entry)) ||
          left.index - right.index
      )
      .map(({ entry }) => entry)
  }
  const ranked = shown.map((entry, index) => {
    const { needsYou, activityAt } = activityOf(entry)
    return { entry, index, needsYou, activityAt: botSidebarEntryRecency(entry, activityAt) }
  })
  return ranked
    .sort(
      (left, right) =>
        (view.sortBy === 'smart' ? Number(right.needsYou) - Number(left.needsYou) : 0) ||
        right.activityAt - left.activityAt ||
        left.index - right.index
    )
    .map(({ entry }) => entry)
}
