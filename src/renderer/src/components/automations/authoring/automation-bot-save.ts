import type {
  Automation,
  AutomationBotTarget,
  AutomationCreateInput,
  AutomationUpdateInput
} from '../../../../../shared/automations/automation-definition'
import { translate } from '@/i18n/i18n'
import { listAutomationsForTarget } from '../hosts/automation-host-client'
import {
  dispatchAutomationReread,
  type AutomationActionNotice
} from '../hosts/automation-row-action-dispatch'
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
import {
  botSchedulePatch,
  isSameBotTarget,
  missingBotResultsPlace,
  trimmedBotTarget
} from '../../../../../shared/automations/bot-automation-target-edit'
import { botAutomationSetup } from '../../../../../shared/bots/bot-agent-setup'
import { isBotAgent } from '../../../../../shared/bot-types'
import type { AutomationHostCatalogEntry } from '../hosts/automation-host-catalog-types'
import { automationHostRecoveryActions } from '../hosts/automation-host-status-descriptors'

/** Why the target cannot be saved yet, or null when it can. */
export function botTargetError(target: AutomationBotTarget): string | null {
  switch (missingBotResultsPlace(target)) {
    case 'channel':
      return translate(
        'automations.botTarget.channelMissing',
        'Enter the channel to send results to.'
      )
    case 'linear':
      return translate(
        'automations.botTarget.linearIssueInvalid',
        'Enter the Linear issue to send results to, like ENG-123.'
      )
    case null:
      return null
  }
}

/** Why the bot's host can't hold a new automation, with the repair that can help: an old server needs updating, not Retry. */
export function botHostUnavailableNotice(
  botHost: AutomationHostCatalogEntry | null
): AutomationActionNotice {
  const recovery = botHost ? automationHostRecoveryActions(botHost).authority : null
  if (botHost && recovery === 'update-server') {
    return {
      message: translate(
        'automations.botTarget.hostNeedsUpdate',
        'Update the Orca server on {host} so its bots can have automations.'
      ).replace('{host}', () => botHost.authorityLabel),
      recovery,
      severity: 'owner'
    }
  }
  return {
    message: translate(
      'automations.botTarget.hostUnavailable',
      "The bot's computer can't hold a new automation yet. Try again in a moment."
    ),
    recovery: recovery ?? 'retry',
    severity: 'owner'
  }
}

/** Saves an automation that runs as a bot; it lives beside its bot, on the bot's host. */
export async function saveBotAutomation(
  context: AutomationSaveContext,
  target: AutomationBotTarget,
  time: { hour: number; minute: number; now: number }
): Promise<void> {
  const { local, destination } = context
  const { draft, editingAutomationId, editingRowKey } = local
  const bot = trimmedBotTarget(target)
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
  const botHost = automationCreateHostFor(
    destination.createDestination.control.entries,
    automationCreateHostStableKey(draft.botHostId)
  )
  const here = resolveAutomationCreateDestination(botHost)
  if (here.status !== 'ready') {
    // Recovery acts on the bot's host, not the Host picker the bot form hides.
    local.setEditorNoticeHost(botHost)
    local.setEditorNotice(botHostUnavailableNotice(botHost))
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
