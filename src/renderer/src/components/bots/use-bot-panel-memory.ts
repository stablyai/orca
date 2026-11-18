// A bot's page opens with its panel showing until the owner closes it there; Orca then remembers, per bot.
// Leaving bots puts back how the panel was before, so other workspaces keep their own choice.
import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { useBotForWorkspace } from './bot-workspace'

const CLOSED_KEY = 'orca.bots.panelClosed'

function readClosed(): Set<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(CLOSED_KEY) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function rememberClosed(botId: string, closed: boolean): void {
  const ids = readClosed()
  if (ids.has(botId) === closed) {
    return
  }
  if (closed) {
    ids.add(botId)
  } else {
    ids.delete(botId)
  }
  try {
    window.localStorage.setItem(CLOSED_KEY, JSON.stringify([...ids]))
  } catch {}
}

/** What the panel showed at one commit: the bot page (if any), open or closed, and the sidebar's last route request. */
export type BotPanelFrame = { botId: string | null; open: boolean; routeRequestId: number }

export type BotPanelStep = {
  /** Open or close the panel. */
  open?: boolean
  /** Remember the owner opened or closed this bot's panel. */
  remember?: { botId: string; closed: boolean }
  /** How the panel was before a bot's page took it over; null outside bots. */
  beforeBots: boolean | null
}

/**
 * Entering a bot's page applies its remembered panel; leaving bots puts back the panel from before.
 * A sidebar request made with the navigation (an Up next reveal, say) wins over both.
 */
export function botPanelStep(
  previous: BotPanelFrame,
  current: BotPanelFrame,
  beforeBots: boolean | null,
  closedBots: ReadonlySet<string>
): BotPanelStep {
  const requested =
    current.routeRequestId !== previous.routeRequestId || current.open !== previous.open
  if (current.botId !== previous.botId) {
    if (current.botId) {
      const before = beforeBots ?? previous.open
      const wanted = !closedBots.has(current.botId)
      return requested || wanted === current.open
        ? { beforeBots: before }
        : { open: wanted, beforeBots: before }
    }
    return requested || beforeBots === null || beforeBots === current.open
      ? { beforeBots: null }
      : { open: beforeBots, beforeBots: null }
  }
  // The owner's own toggle is remembered; a reveal that opens the panel decides nothing for next time.
  return current.botId &&
    current.open !== previous.open &&
    current.routeRequestId === previous.routeRequestId
    ? { remember: { botId: current.botId, closed: !current.open }, beforeBots }
    : { beforeBots }
}

export function useBotPanelMemory(): void {
  const botId = useBotForWorkspace(useAppStore((s) => s.activeWorktreeId))?.id ?? null
  const open = useAppStore((s) => s.rightSidebarOpen)
  const routeRequestId = useAppStore((s) => s.rightSidebarRouteRequestId)
  const last = useRef<BotPanelFrame>({ botId: null, open, routeRequestId })
  const beforeBots = useRef<boolean | null>(null)

  // Why an effect: the panel follows navigation, which arrives from many places outside this hook.
  useEffect(() => {
    const current = { botId, open, routeRequestId }
    const step = botPanelStep(last.current, current, beforeBots.current, readClosed())
    last.current = current
    beforeBots.current = step.beforeBots
    if (step.remember) {
      rememberClosed(step.remember.botId, step.remember.closed)
    }
    if (step.open !== undefined) {
      useAppStore.getState().setRightSidebarOpen(step.open)
    }
  }, [botId, open, routeRequestId])
}
