// An item status as people read it, and a group's title; the desktop and the phone both say it here.
import type { BotItemStatus } from './bot-items'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

export function botItemStatusName(status: BotItemStatus, t: Translate): string {
  switch (status) {
    case 'planned':
      return t('bots.items.status.planned', 'Planned')
    case 'working':
      return t('bots.items.status.working', 'In progress')
    case 'needs_you':
      return t('bots.items.status.needsYou', 'Needs you')
    case 'done':
      return t('bots.items.status.done', 'Done')
    case 'canceled':
      return t('bots.items.status.canceled', 'Canceled')
  }
}

/** A group's title: a status's name, or Snoozed, Stale or Closed. */
export function botItemGroupName(
  id: BotItemStatus | 'snoozed' | 'stale' | 'closed',
  t: Translate
): string {
  if (id === 'snoozed') {
    return t('bots.items.group.snoozed', 'Snoozed')
  }
  if (id === 'stale') {
    return t('bots.items.group.stale', 'Stale')
  }
  return id === 'closed' ? t('bots.items.group.closed', 'Closed') : botItemStatusName(id, t)
}
