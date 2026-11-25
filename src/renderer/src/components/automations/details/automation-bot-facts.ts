import { botAgentLabel } from '@/components/bots/bot-presentation'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
// What a bot automation does, in words: when it runs, where its results go, the zone its hours are
// read in. Shared by the chat's automation card and the bot panel's Automation screen.
import { translate } from '@/i18n/i18n'
import type {
  Automation,
  AutomationBotResultsTo
} from '../../../../../shared/automations/automation-definition'
import type { AutomationAuthorityRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import { botAutomationWhenParts } from '../../../../../shared/bots/bot-automation-when'
import { hasAutomationSchedule } from '../../../../../shared/automation-event-triggers'
import { botResultsPlace } from '../../../../../shared/automation-bot-target'
import { eventTriggerLine } from '../authoring/AutomationBotEventsField'
import { formatUiAutomationScheduleDescriptor } from './automation-schedule-label'

/** One line per schedule or event it runs on. */
export function automationWhenLines(automation: Automation): string[] {
  return botAutomationWhenParts(automation).map((part) =>
    part.kind === 'schedule'
      ? formatUiAutomationScheduleDescriptor(part.schedule)
      : eventTriggerLine(part.trigger)
  )
}

export function automationResultsPlace(resultsTo: AutomationBotResultsTo | undefined): string {
  if (resultsTo === undefined) {
    return translate('components.native-chat.automationSaved.resultsInEachRun', 'In each run')
  }
  if (resultsTo === 'chat') {
    return translate('components.native-chat.automationSaved.resultsChat', 'Chat')
  }
  if (resultsTo === 'thread') {
    return translate('automations.botTarget.resultsToThread', "The event's thread")
  }
  if (resultsTo === 'none') {
    return translate('automations.botTarget.resultsToNone', 'Nowhere')
  }
  return botResultsPlace(resultsTo)
}

/** This viewer's zone. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * The zone the host reads the schedule's hours in, mirroring the host's own rule
 * (`automationScheduleZone`): a named zone holds everywhere, a server keeps the zone saved with it,
 * and a desktop follows its own clock, which for this computer is the viewer's.
 */
export function automationEffectiveZone(
  automation: Pick<Automation, 'timezone' | 'timezoneExplicit'>,
  authority: AutomationAuthorityRef
): string | null {
  if (automation.timezoneExplicit || authority.kind === 'runtime') {
    return automation.timezone || null
  }
  return viewerTimeZone()
}

/** The zone to name beside the schedule: only a scheduled one, and only when it isn't the viewer's. */
export function automationZoneLabel(
  automation: Pick<Automation, 'timezone' | 'timezoneExplicit' | 'dtstart'>,
  authority: AutomationAuthorityRef,
  viewerZone: string = viewerTimeZone()
): string | null {
  if (!hasAutomationSchedule(automation)) {
    return null
  }
  const zone = automationEffectiveZone(automation, authority)
  return zone && zone !== viewerZone ? zone : null
}

export function automationAgentLabel(automation: Pick<Automation, 'bot' | 'agentId'>): string {
  return automation.bot
    ? botAgentLabel(automation.agentId)
    : (getAgentCatalog().find((agent) => agent.id === automation.agentId)?.label ??
        automation.agentId)
}
