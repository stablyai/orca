// How the desktop words an automation run's row: each phrase by its own key, times as the chat's
// wait cards write them, and the automation's schedule.
import { useMemo } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatWaitTime } from '@/components/bots/bot-wait-copy'
import { formatUiAutomationScheduleDescriptor } from '@/components/automations/details/automation-schedule-label'
import { botAutomationWhenParts } from '../../../../../shared/bots/bot-automation-when'
import type { BotAutomationFacts } from '../../../../../shared/bots/bot-automation-rows'
import {
  AUTOMATION_RUN_COPY,
  type AutomationRunCopyKey,
  type AutomationRunWording,
  type SayAutomationRun
} from '../../../../../shared/automations/automation-run-row-words'

// Literal keys, so localization extraction keeps each.
const KEYS: Record<AutomationRunCopyKey, string> = {
  waitOver: 'components.native-chat.automationRun.waitOver',
  scheduled: 'components.native-chat.automationRun.scheduled',
  runNow: 'components.native-chat.automationRun.runNow',
  github: 'components.native-chat.automationRun.github',
  slack: 'components.native-chat.automationRun.slack',
  linear: 'components.native-chat.automationRun.linear',
  webhook: 'components.native-chat.automationRun.webhook',
  gmail: 'components.native-chat.automationRun.gmail',
  calendar: 'components.native-chat.automationRun.calendar',
  instructions: 'components.native-chat.automationRun.instructions',
  event: 'components.native-chat.automationRun.event',
  startError: 'components.native-chat.automationRun.startError',
  couldNotStart: 'components.native-chat.automationRun.couldNotStart',
  queued: 'components.native-chat.automationRun.queued',
  deadlineReached: 'components.native-chat.automationRun.deadlineReached',
  due: 'components.native-chat.automationRun.due',
  dueRan: 'components.native-chat.automationRun.dueRan',
  reused: 'components.native-chat.automationRun.reused',
  reusedFrom: 'components.native-chat.automationRun.reusedFrom',
  whatOn: 'components.native-chat.automationRun.whatOn',
  whatIn: 'components.native-chat.automationRun.whatIn',
  whatAt: 'components.native-chat.automationRun.whatAt',
  factsAt: 'components.native-chat.automationRun.factsAt',
  someoneWrote: 'components.native-chat.automationRun.someoneWrote',
  personWrote: 'components.native-chat.automationRun.personWrote',
  callerSent: 'components.native-chat.automationRun.callerSent',
  external: 'components.native-chat.automationRun.external',
  shortened: 'components.native-chat.automationRun.shortened',
  memberAccess: 'components.native-chat.automationRun.memberAccess',
  someMemberAccess: 'components.native-chat.automationRun.someMemberAccess',
  otherAccess: 'components.native-chat.automationRun.otherAccess',
  ownerAccess: 'components.native-chat.automationRun.ownerAccess',
  sampleCall: 'components.native-chat.automationRun.sampleCall',
  firstCall: 'components.native-chat.automationRun.firstCall',
  webhookCall: 'components.native-chat.automationRun.webhookCall',
  openOnGitHub: 'components.native-chat.automationRun.openOnGitHub',
  openInSlack: 'components.native-chat.automationRun.openInSlack',
  openInLinear: 'components.native-chat.automationRun.openInLinear',
  openLink: 'components.native-chat.automationRun.openLink',
  accessibleName: 'components.native-chat.automationRun.accessibleName',
  accessibleNameAt: 'components.native-chat.automationRun.accessibleNameAt',
  accessibleNameNoReason: 'components.native-chat.automationRun.accessibleNameNoReason',
  accessibleNameNoReasonAt: 'components.native-chat.automationRun.accessibleNameNoReasonAt',
  copyInstructions: 'components.native-chat.automationRun.copyInstructions',
  copyEvent: 'components.native-chat.automationRun.copyEvent',
  openAutomation: 'components.native-chat.automationRun.openAutomation',
  sendAgain: 'components.native-chat.automationRun.sendAgain',
  sentAgain: 'components.native-chat.automationRun.sentAgain',
  showAll: 'components.native-chat.automationRun.showAll',
  showLess: 'components.native-chat.automationRun.showLess',
  waiting: 'components.native-chat.automationRun.waiting',
  cancelled: 'components.native-chat.automationRun.cancelled',
  until: 'components.native-chat.automationRun.until',
  noDeadline: 'components.native-chat.automationRun.noDeadline',
  replied: 'components.native-chat.automationRun.replied',
  happened: 'components.native-chat.automationRun.happened',
  noReplyBy: 'components.native-chat.automationRun.noReplyBy',
  nothingBy: 'components.native-chat.automationRun.nothingBy',
  afterThirtyDays: 'components.native-chat.automationRun.afterThirtyDays',
  waitsFor: 'components.native-chat.automationRun.waitsFor',
  thenLine: 'components.native-chat.automationRun.thenLine',
  thenAt: 'components.native-chat.automationRun.thenAt',
  thenOnce: 'components.native-chat.automationRun.thenOnce',
  thenOnceBy: 'components.native-chat.automationRun.thenOnceBy',
  cancel: 'components.native-chat.automationRun.cancel',
  createdAutomation: 'components.native-chat.automationRun.createdAutomation',
  updatedAutomation: 'components.native-chat.automationRun.updatedAutomation',
  paused: 'components.native-chat.automationRun.paused',
  finished: 'components.native-chat.automationRun.finished',
  couldNotFinish: 'components.native-chat.automationRun.couldNotFinish',
  rowAccessibleName: 'components.native-chat.automationRun.rowAccessibleName',
  'what.github.issue_opened': 'components.native-chat.automationRun.what.github.issue_opened',
  'what.github.pr_opened': 'components.native-chat.automationRun.what.github.pr_opened',
  'what.github.pr_pushed': 'components.native-chat.automationRun.what.github.pr_pushed',
  'what.github.pr_merged': 'components.native-chat.automationRun.what.github.pr_merged',
  'what.github.comment': 'components.native-chat.automationRun.what.github.comment',
  'what.github.review_comment': 'components.native-chat.automationRun.what.github.review_comment',
  'what.github.review': 'components.native-chat.automationRun.what.github.review',
  'what.github.mentioned': 'components.native-chat.automationRun.what.github.mentioned',
  'what.github.review_requested':
    'components.native-chat.automationRun.what.github.review_requested',
  'what.github.assigned': 'components.native-chat.automationRun.what.github.assigned',
  'what.github.ci_failed': 'components.native-chat.automationRun.what.github.ci_failed',
  'what.github.ci_passed': 'components.native-chat.automationRun.what.github.ci_passed',
  'what.github.ci_finished': 'components.native-chat.automationRun.what.github.ci_finished',
  'what.github.pr_conflicted': 'components.native-chat.automationRun.what.github.pr_conflicted',
  'what.github.pr_closed': 'components.native-chat.automationRun.what.github.pr_closed',
  'what.github.pr_ready': 'components.native-chat.automationRun.what.github.pr_ready',
  'what.github.labeled': 'components.native-chat.automationRun.what.github.labeled',
  'what.github.issue_closed': 'components.native-chat.automationRun.what.github.issue_closed',
  'what.github.deploy_finished': 'components.native-chat.automationRun.what.github.deploy_finished',
  'what.github.security_alert': 'components.native-chat.automationRun.what.github.security_alert',
  'what.github.workflow_finished':
    'components.native-chat.automationRun.what.github.workflow_finished',
  'what.slack.mentioned': 'components.native-chat.automationRun.what.slack.mentioned',
  'what.slack.message': 'components.native-chat.automationRun.what.slack.message',
  'what.slack.reaction': 'components.native-chat.automationRun.what.slack.reaction',
  'what.linear.assigned': 'components.native-chat.automationRun.what.linear.assigned',
  'what.linear.mentioned': 'components.native-chat.automationRun.what.linear.mentioned',
  'what.linear.issue_created': 'components.native-chat.automationRun.what.linear.issue_created',
  'what.linear.issue_moved': 'components.native-chat.automationRun.what.linear.issue_moved',
  'what.gmail.new_email': 'components.native-chat.automationRun.what.gmail.new_email',
  'what.calendar.starting_soon': 'components.native-chat.automationRun.what.calendar.starting_soon',
  'what.other': 'components.native-chat.automationRun.what.other'
}

/** Says a run row's phrase in the desktop's language. */
export function sayAutomationRun(t: Translate): SayAutomationRun {
  return (key, params) => t(KEYS[key], AUTOMATION_RUN_COPY[key], params)
}

/** An automation's row wording: a run's as saved when it ran, or the automation's own. */
export function useAutomationRunWording(
  automation: Pick<BotAutomationFacts, 'dtstart' | 'rrule' | 'on'>
): AutomationRunWording {
  const t = useTranslate()
  return useMemo(() => {
    const schedule = botAutomationWhenParts(automation).find((part) => part.kind === 'schedule')
    return {
      say: sayAutomationRun(t),
      formatTime: (at) => formatWaitTime(at),
      schedule:
        schedule?.kind === 'schedule'
          ? formatUiAutomationScheduleDescriptor(schedule.schedule, t)
          : ''
    }
  }, [automation, t])
}
