// Where an automation link opens: beside the bot that owns it, in its side panel, or the Automations
// page. Bot surfaces pass the bot; anything without one, or asking for the page, goes to the page.
import type { AutomationOwnerRef } from '../../../../shared/automations/ownership/automation-owner-ref'
import {
  automationOwnerForHostId,
  evaluateAutomationOwner
} from '../automations/hosts/automation-host-owner'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { openBotHome } from '@/lib/bot-catalog'
import { readHostBots } from '@/lib/bot-catalog-snapshot'
import type { BotRef } from '@/lib/bot-hosts'
import { useAppStore } from '@/store'
import {
  parseRoutableExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { setBotSettingsPlace } from './settings-view/bot-settings-place'
import { setBotAutomationPlace } from './bot-automation-place'

export type BotAutomationIntent = 'detail' | 'page'

export type BotAutomationOpen = {
  /** The bot whose panel shows it; null for callers with no bot, which open the page. */
  bot: BotRef | null
  automationId: string
  runId: string | null
  /** `detail` (default): the bot's panel. `page`: the Automations page. */
  intent?: BotAutomationIntent
  /** The record's execution host, kept for the page; defaults to the bot's. */
  hostId?: ExecutionHostId | null
  /** The Activity row it was opened from, so Back returns focus there. */
  originRowKey?: string
  owner: AutomationOwnerRef | null
}

function openPage(open: BotAutomationOpen): void {
  const state = useAppStore.getState()
  const hostId = open.hostId ?? open.bot?.hostId ?? null
  state.setPendingAutomationRunNavigation({
    automationId: open.automationId,
    runId: open.runId,
    ...(hostId ? { hostId } : {})
  })
  state.openAutomationsPage()
}

/** The Activity panel's scroller, whose position Back restores. */
function activityScrollTop(): number | null {
  const scroller = document.querySelector<HTMLElement>('[data-bot-activity-scroller]')
  return scroller ? scroller.scrollTop : null
}

/** Opens an automation, or one of its runs: in its bot's panel when there is one, else the page. */
export function openBotAutomation(open: BotAutomationOpen): void {
  const continuity = open.owner ? evaluateAutomationOwner(open.owner) : null
  const target = automationOwnerForHostId(
    open.hostId ?? open.bot?.hostId ?? '',
    useAppStore.getState()
  )
  if (
    !continuity ||
    (continuity.status !== 'same' && continuity.status !== 'continued') ||
    !target ||
    JSON.stringify(target) !== JSON.stringify(continuity.owner)
  ) {
    toast.error(
      translate(
        'bots.automationPanel.refreshBeforeOpen',
        'This computer changed. Refresh this automation before opening it.'
      )
    )
    return
  }
  open = { ...open, owner: continuity.owner }
  if (open.intent === 'page' || !open.bot) {
    openPage(open)
    return
  }
  const ref = open.bot
  const bot = parseRoutableExecutionHostId(ref.hostId)
    ? readHostBots(ref.hostId).find((entry) => entry.id === ref.id)
    : undefined
  const originScrollTop = activityScrollTop()
  if (!bot || !openBotHome(bot)) {
    openPage(open)
    toast.message(
      translate(
        'bots.automationPanel.openedOnPage',
        "Opened in Automations: the bot's page isn't available."
      )
    )
    return
  }
  setBotSettingsPlace('panel', null)
  setBotAutomationPlace({
    bot: { hostId: bot.hostId, id: bot.id },
    automationId: open.automationId,
    owner: open.owner ?? undefined,
    runId: open.runId,
    originRowKey: open.originRowKey ?? null,
    originScrollTop
  })
  const { setRightSidebarTab, setRightSidebarOpen } = useAppStore.getState()
  setRightSidebarTab('bot-activity')
  setRightSidebarOpen(true)
}
