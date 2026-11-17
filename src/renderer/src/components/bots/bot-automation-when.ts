import { translate } from '@/i18n/i18n'
import { formatUiAutomationScheduleDescriptor } from '../automations/details/automation-schedule-label'
import {
  isConnectorSource,
  type AutomationEventKind,
  type AutomationEventTrigger
} from '../../../../shared/automation-event-triggers'
import { botAutomationWhenParts } from '../../../../shared/bots/bot-automation-when'
import { placesPhrase, subjectPhrase } from './bot-automation-event-places'
import type {
  BotAutomationFacts,
  BotAutomationTrigger
} from '../../../../shared/bots/bot-automation-rows'

type ConnectorTriggerFacts = Extract<
  BotAutomationTrigger,
  { source: 'slack' | 'github' | 'linear' }
>

function isConnectorTriggerFacts(trigger: BotAutomationTrigger): trigger is ConnectorTriggerFacts {
  return isConnectorSource(trigger.source)
}

type SlackTrigger = Extract<AutomationEventTrigger, { source: 'slack' }>
type GitHubTrigger = Extract<AutomationEventTrigger, { source: 'github' }>
type LinearTrigger = Extract<AutomationEventTrigger, { source: 'linear' }>

function slackLabel(event: SlackTrigger['event']): string {
  switch (event) {
    case 'mentioned':
      return translate('bots.automations.on.slackMentioned', 'When you’re mentioned in Slack')
    case 'message':
      return translate('bots.automations.on.slackMessage', 'On a Slack message')
    case 'reaction':
      return translate('bots.automations.on.slackReaction', 'On a Slack reaction')
  }
}

function githubLabel(event: GitHubTrigger['event']): string {
  switch (event) {
    case 'issue_opened':
      return translate('bots.automations.on.githubIssueOpened', 'When an issue is opened')
    case 'pr_opened':
      return translate('bots.automations.on.githubPrOpened', 'When a pull request is opened')
    case 'pr_pushed':
      return translate('bots.automations.on.githubPrPushed', 'On a push to a pull request')
    case 'pr_merged':
      return translate('bots.automations.on.githubPrMerged', 'When a pull request merges')
    case 'comment':
      return translate('bots.automations.on.githubComment', 'On a GitHub comment')
    case 'review_comment':
      return translate('bots.automations.on.githubReviewComment', 'On a review comment')
    case 'review':
      return translate('bots.automations.on.githubReview', 'On a pull request review')
    case 'mentioned':
      return translate('bots.automations.on.githubMentioned', 'When mentioned on GitHub')
    case 'review_requested':
      return translate('bots.automations.on.githubReviewRequested', 'When a review is requested')
    case 'assigned':
      return translate('bots.automations.on.githubAssigned', 'When assigned on GitHub')
    case 'ci_failed':
      return translate('bots.automations.on.githubCiFailed', 'When CI fails')
    case 'ci_passed':
      return translate('bots.automations.on.githubCiPassed', 'When CI passes')
    case 'ci_finished':
      return translate('bots.automations.on.githubCiFinished', 'When CI finishes')
    case 'pr_conflicted':
      return translate(
        'bots.automations.on.githubPrConflicted',
        'When a pull request has conflicts'
      )
    case 'pr_closed':
      return translate('bots.automations.on.githubPrClosed', 'When a pull request is closed')
    case 'pr_ready':
      return translate(
        'bots.automations.on.githubPrReady',
        'When a pull request is ready for review'
      )
    case 'labeled':
      return translate('bots.automations.on.githubLabeled', 'When a label is added')
    case 'issue_closed':
      return translate('bots.automations.on.githubIssueClosed', 'When an issue is closed')
    case 'deploy_finished':
      return translate('bots.automations.on.githubDeployFinished', 'When a deployment finishes')
    case 'security_alert':
      return translate('bots.automations.on.githubSecurityAlert', 'On a security alert')
    case 'workflow_finished':
      return translate('bots.automations.on.githubWorkflowFinished', 'When a workflow run finishes')
  }
}

function linearLabel(event: LinearTrigger['event']): string {
  switch (event) {
    case 'assigned':
      return translate('bots.automations.on.linearAssigned', 'When assigned in Linear')
    case 'mentioned':
      return translate('bots.automations.on.linearMentioned', 'When mentioned in Linear')
    case 'issue_created':
      return translate('bots.automations.on.linearIssueCreated', 'When a Linear issue is created')
    case 'issue_moved':
      return translate('bots.automations.on.linearIssueMoved', 'When a Linear issue moves')
  }
}

export function eventLabel(trigger: AutomationEventKind): string {
  switch (trigger.source) {
    case 'slack':
      return slackLabel(trigger.event)
    case 'github':
      return githubLabel(trigger.event)
    case 'linear':
      return linearLabel(trigger.event)
    case 'webhook':
      return translate('bots.automations.on.webhookCall', 'When its webhook is called')
    case 'gmail':
      return translate('bots.automations.on.gmailNewEmail', 'On a new email')
    case 'calendar':
      return translate('bots.automations.on.calendarStartingSoon', 'Before a meeting starts')
  }
}

/** "On a Slack message in a thread in #orca": an event and where, so two events read apart. */
export function eventWithPlace(trigger: BotAutomationTrigger): string {
  const place = isConnectorTriggerFacts(trigger)
    ? (subjectPhrase(trigger) ?? placesPhrase(trigger))
    : null
  return place ? `${eventLabel(trigger)} ${place}` : eventLabel(trigger)
}

/** When an automation runs, in words: its schedule, then each event that starts it. */
export function botAutomationWhen(automation: BotAutomationFacts): string {
  return botAutomationWhenParts(automation)
    .map((part) =>
      part.kind === 'schedule'
        ? formatUiAutomationScheduleDescriptor(part.schedule)
        : eventWithPlace(part.trigger)
    )
    .join(' · ')
}
