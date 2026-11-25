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
  /** A bot's worker lines with nothing running drop off, as the projects' Hide sleeping. */
  hideSleepingWorkers: boolean
}

export const DEFAULT_BOT_SIDEBAR_VIEW: BotSidebarView = {
  sortBy: 'manual',
  hidePausedBots: false,
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
    hideSleepingWorkers: saved.hideSleepingWorkers === true
  }
}

/** How many options differ from the default, for the button's badge. */
export function countActiveBotSidebarFilters(view: BotSidebarView): number {
  return Number(view.hidePausedBots) + Number(view.hideSleepingWorkers)
}

type ArrangedEntry = (
  | { kind: 'bot'; bot: { name: string; paused: boolean; createdAt?: unknown } }
  | { kind: 'group'; group: { name: string; createdAt?: unknown } }
) & {
  isPinned?: boolean
}

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

/** The Bots section's rows as the options list them; pinned rows lead, and saved (Manual) order breaks ties. */
export function arrangeBotSidebarEntries<E extends ArrangedEntry>(
  entries: readonly E[],
  view: BotSidebarView,
  activityOf: (entry: E) => BotSidebarEntryActivity
): E[] {
  // Groups are rooms the owner made on purpose; only bots pause.
  const shown = view.hidePausedBots
    ? entries.filter((entry) => entry.kind !== 'bot' || !entry.bot.paused)
    : [...entries]
  const byPinned = (left: E, right: E): number =>
    Number(right.isPinned === true) - Number(left.isPinned === true)
  if (view.sortBy === 'manual') {
    return shown
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => byPinned(left.entry, right.entry) || left.index - right.index)
      .map(({ entry }) => entry)
  }
  const name = (entry: E): string => (entry.kind === 'bot' ? entry.bot.name : entry.group.name)
  if (view.sortBy === 'name') {
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
    return shown
      .map((entry, index) => ({ entry, index }))
      .sort(
        (left, right) =>
          byPinned(left.entry, right.entry) ||
          collator.compare(name(left.entry), name(right.entry)) ||
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
        byPinned(left.entry, right.entry) ||
        (view.sortBy === 'smart' ? Number(right.needsYou) - Number(left.needsYou) : 0) ||
        right.activityAt - left.activityAt ||
        left.index - right.index
    )
    .map(({ entry }) => entry)
}
