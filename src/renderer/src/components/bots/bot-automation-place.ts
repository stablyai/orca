// Which automation a bot's side panel shows instead of its Activity, if any. One slot, qualified by
// the bot's host: the same bot id on two computers is two bots.
import type { AutomationOwnerRef } from '../../../../shared/automations/ownership/automation-owner-ref'
import { useSyncExternalStore } from 'react'
import { botRefKey, isSameBot, type BotRef } from '@/lib/bot-hosts'

export type BotAutomationPlace = {
  bot: BotRef
  owner?: AutomationOwnerRef
  automationId: string
  /** A run to expand (and pin, when it isn't among the newest). */
  runId: string | null
  /** The Activity row it was opened from, to return focus to; `auto:<id>` for a Scheduled row. */
  originRowKey: string | null
  /** Activity's scroll position when it was left, restored on Back. */
  originScrollTop: number | null
}

let place: BotAutomationPlace | null = null
let returnOrigin: BotAutomationPlace | null = null
/** Bumped by every open, so a screen re-opened at the same place still re-reads and re-focuses. */
let openCount = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setBotAutomationPlace(next: BotAutomationPlace | null): void {
  if (next) {
    returnOrigin = null
  }
  place = next
  openCount += 1
  listeners.forEach((listener) => listener())
}

export function readBotAutomationPlace(): BotAutomationPlace | null {
  return place
}

/** The automation this bot's panel shows; null when it shows Activity, or another bot's. */
export function useBotAutomationPlace(bot: BotRef): BotAutomationPlace | null {
  const current = useSyncExternalStore(subscribe, () => place)
  return current && isSameBot(current.bot, bot) ? current : null
}

export function botAutomationReturnRevealsNeeds(
  bot: BotRef,
  needs: readonly { key: string }[],
  stopped: readonly { key: string }[]
): boolean {
  const origin = returnOrigin && isSameBot(returnOrigin.bot, bot) ? returnOrigin.originRowKey : null
  return Boolean(
    origin &&
    (needs.some((need) => need.key === origin) ||
      stopped.some((row) => `stopped:${row.key}` === origin))
  )
}

/** Changes on every open, for keying the screen. */
export function useBotAutomationOpenCount(): number {
  return useSyncExternalStore(subscribe, () => openCount)
}

export function botAutomationPlaceKey(next: BotAutomationPlace): string {
  return `${botRefKey(next.bot)}\u0000${next.automationId}`
}

/**
 * Back from the Automation screen: Activity again, at the scroll it was left at, with focus on the
 * row it was opened from, or on the Automations card when that row is gone (or after a delete).
 */
export function returnToActivity(
  panel: HTMLElement | null,
  place: BotAutomationPlace,
  focus: 'origin' | 'automations'
): void {
  const hadFocus = panel?.contains(document.activeElement) ?? false
  returnOrigin = place
  setBotAutomationPlace(null)
  requestAnimationFrame(() => {
    const scroller = panel?.querySelector<HTMLElement>('[data-bot-activity-scroller]')
    if (scroller && place.originScrollTop !== null) {
      scroller.scrollTop = place.originScrollTop
    }
    if (!hadFocus) {
      return
    }
    const row =
      focus === 'origin' && place.originRowKey
        ? panel?.querySelector<HTMLElement>(
            `[data-activity-row-key="${CSS.escape(place.originRowKey)}"]`
          )
        : null
    const fallback = panel?.querySelector<HTMLElement>('[data-bot-automations-new]')
    const visibleRow = row?.closest('[hidden]') ? null : row
    const target =
      (visibleRow?.matches('button, [tabindex]')
        ? visibleRow
        : visibleRow?.querySelector<HTMLElement>('button, [tabindex]')) ??
      fallback ??
      scroller
    target?.focus({ preventScroll: true })
  })
}
