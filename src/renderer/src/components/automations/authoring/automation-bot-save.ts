import type {
  Automation,
  AutomationBotTarget,
  AutomationCreateInput,
  AutomationUpdateInput
} from '../../../../../shared/automations/automation-definition'
import { translate } from '@/i18n/i18n'
import {
  EVENT_ONLY_SCHEDULE,
  hasAutomationSchedule
} from '../../../../../shared/automation-event-triggers'
import { listAutomationsForTarget } from '../hosts/automation-host-client'
import { dispatchAutomationReread } from '../hosts/automation-row-action-dispatch'
import {
  automationCreateHostFor,
  automationCreateHostStableKey,
  resolveAutomationCreateDestination
} from './automation-create-destination'
import { buildDraftSchedule } from './automation-draft-model'
import {
  createAutomationOnDestination,
  saveExistingAutomation
} from './automation-orca-save-operations'
import { completeAutomationSave } from './automation-save-completion'
import type { AutomationSaveContext } from './automation-save-context'
import { botResultsPlace, withBotResultsPlace } from './automation-bot-results-to'
import { botAutomationSetup, sameBotAgentSetup } from '../../../../../shared/bots/bot-agent-setup'
import { isBotAgent } from '../../../../../shared/bot-types'
import { readBots } from '@/lib/bot-catalog'

/** Why the target cannot be saved yet, or null when it can. */
export function botTargetError(target: AutomationBotTarget): string | null {
  const { resultsTo } = target
  if (typeof resultsTo !== 'object') {
    return null
  }
  if ('channel' in resultsTo) {
    return resultsTo.channel.trim()
      ? null
      : translate('automations.botTarget.channelMissing', 'Enter the channel to send results to.')
  }
  // A key, a link or a saved ref; the host looks it up on save.
  return resultsTo.linearIssue.trim()
    ? null
    : translate(
        'automations.botTarget.linearIssueInvalid',
        'Enter the Linear issue to send results to, like ENG-123.'
      )
}

function resultsKey(target: AutomationBotTarget): string {
  const { resultsTo } = target
  if (typeof resultsTo !== 'object') {
    return resultsTo
  }
  return 'channel' in resultsTo ? `channel:${resultsTo.channel}` : `linear:${resultsTo.linearIssue}`
}

/** Unchanged targets are left out of an edit. */
export function isSameBotTarget(
  left: AutomationBotTarget | undefined,
  right: AutomationBotTarget
): boolean {
  return (
    left !== undefined &&
    left.botId === right.botId &&
    left.runsIn === right.runsIn &&
    left.chat?.sessionId === right.chat?.sessionId &&
    resultsKey(left) === resultsKey(right) &&
    Boolean(left.letBotReact) === Boolean(right.letBotReact) &&
    sameBotAgentSetup(left.agentSetup, right.agentSetup)
  )
}

/** The schedule fields an edit sends: none while unchanged, the never-reached one for "Only on events". */
export function botSchedulePatch(
  eventsOnly: boolean,
  current: Automation | null,
  schedule: { rrule: string; dtstart: number }
): Partial<Pick<AutomationUpdateInput, 'rrule' | 'dtstart'>> {
  const scheduled = current === null || hasAutomationSchedule(current)
  if (eventsOnly) {
    return scheduled ? { ...EVENT_ONLY_SCHEDULE } : {}
  }
  // A picked schedule is new even when its rule matches the never-reached one.
  return !scheduled || current?.rrule !== schedule.rrule ? schedule : {}
}

/** Saves an automation that runs as a bot; it lives beside its bot, on the bot's host. */
export async function saveBotAutomation(
  context: AutomationSaveContext,
  target: AutomationBotTarget,
  time: { hour: number; minute: number; now: number }
): Promise<void> {
  const { local, destination } = context
  const { draft, editingAutomationId, editingRowKey } = local
  const bot: AutomationBotTarget =
    typeof target.resultsTo === 'object'
      ? {
          ...target,
          resultsTo: withBotResultsPlace(target.resultsTo, botResultsPlace(target.resultsTo).trim())
        }
      : target
  const { timezone, rrule, missedRunGraceMinutes } = buildDraftSchedule(draft, time)

  if (editingAutomationId !== null) {
    const reread = await dispatchAutomationReread(
      destination.automationDispatchContext,
      { rowKey: editingRowKey ?? '', automationId: editingAutomationId },
      async () =>
        (
          await listAutomationsForTarget(destination.automationHostTarget ?? { kind: 'local' })
        ).find((automation) => automation.id === editingAutomationId) ?? null
    )
    if (!reread.ok && reread.notice.severity === 'owner') {
      local.setEditorNotice(reread.notice)
      return
    }
    const current: Automation | null =
      (reread.ok ? reread.value : null) ??
      local.automations.find((automation) => automation.id === editingAutomationId) ??
      null
    // The bot supplies the agent, folder and session, so only what the bot form shows is sent.
    const updates: AutomationUpdateInput = {
      name: draft.name,
      prompt: draft.prompt,
      // Unchanged, it is left out, so an automation whose bot was deleted can still be renamed.
      ...(isSameBotTarget(current?.bot, bot) ? {} : { bot }),
      timezone,
      missedRunGraceMinutes,
      ...botSchedulePatch(draft.eventsOnly === true, current, { rrule, dtstart: time.now })
    }
    const saved = await saveExistingAutomation(
      context,
      editingAutomationId,
      current,
      updates,
      undefined,
      destination.automationHostTarget,
      editingRowKey
    )
    if (!saved.ok) {
      local.setEditorNotice(saved.notice)
      return
    }
    await completeAutomationSave(context, saved.value, null, false)
    return
  }

  // Like the CLI's --bot, the automation lives on the host that runs its bot.
  const botHostId = readBots().find((entry) => entry.id === bot.botId)?.hostId
  const botHost = automationCreateHostFor(
    destination.createDestination.control.entries,
    automationCreateHostStableKey(botHostId)
  )
  const here = resolveAutomationCreateDestination(botHost)
  if (here.status !== 'ready') {
    // Recovery acts on the bot's host, not the Host picker the bot form hides.
    local.setEditorNoticeHost(botHost)
    local.setEditorNotice({
      message: translate(
        'automations.botTarget.hostUnavailable',
        "The bot's computer can't hold a new automation yet. Try again in a moment."
      ),
      recovery: 'retry',
      severity: 'owner'
    })
    return
  }
  const input: AutomationCreateInput = {
    name: draft.name,
    prompt: draft.prompt,
    // The host records the agent runs start on; the draft holds the bot's.
    agentId: isBotAgent(draft.agentId)
      ? botAutomationSetup(bot, { agent: draft.agentId }).agent
      : draft.agentId,
    bot,
    projectId: '',
    workspaceMode: 'existing',
    timezone,
    rrule,
    dtstart: time.now,
    missedRunGraceMinutes
  }
  const saved = await createAutomationOnDestination(
    here.authority,
    input,
    here,
    destination.invalidateWrittenHost
  )
  if (!saved.ok) {
    local.setEditorNotice(saved.notice)
    local.setEditorNoticeHost(botHost)
    return
  }
  await completeAutomationSave(context, saved.value, null, false)
}
