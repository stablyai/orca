// GitHub's newer events, and the filters only some GitHub events take.
import type {
  AutomationConnectorEventTrigger,
  AutomationEventTrigger
} from './automation-event-triggers'
import type { Automation } from './automations/automation-definition'

/** GitHub events only an Orca Cloud listing `triggers.github2` sends; an older one never would. */
export const GITHUB2_EVENT_KINDS: readonly string[] = [
  'ci_passed',
  'pr_conflicted',
  'pr_closed',
  'pr_ready',
  'labeled',
  'issue_closed',
  'deploy_finished',
  'security_alert'
]

/** A pull request's state, which Orca Cloud reads only for one it is told to follow: subject= names
 *  it, and nobody "does" it, so from= has nothing to match. */
export const PR_STATE_EVENT_KINDS: readonly string[] = ['ci_passed', 'pr_conflicted']

/** GitHub events only an Orca Cloud listing `triggers.workflows` sends. */
export const WORKFLOW_EVENT_KINDS: readonly string[] = ['workflow_finished']

/** Whether a rule needs an Orca Cloud that lists `triggers.workflows`. */
export function needsWorkflows(trigger: AutomationEventTrigger): boolean {
  return trigger.source === 'github' && WORKFLOW_EVENT_KINDS.includes(trigger.event)
}

/** Whether a rule needs an Orca Cloud that lists `triggers.github2`. */
export function needsGitHub2(trigger: AutomationEventTrigger): boolean {
  return (
    trigger.source === 'github' &&
    (GITHUB2_EVENT_KINDS.includes(trigger.event) || trigger.label !== undefined)
  )
}

// label= names what github.labeled was given; a pull request's state follows one pull request; a
// finished workflow run is one run.
export function assertGitHubFilters(trigger: AutomationConnectorEventTrigger): void {
  const name = `${trigger.source}.${trigger.event}`
  if (trigger.label !== undefined && name !== 'github.labeled') {
    throw new Error(`label= is for github.labeled only, not ${name}.`)
  }
  if (trigger.run !== undefined && name !== 'github.workflow_finished') {
    throw new Error(`run= is for github.workflow_finished only, not ${name}.`)
  }
  if (name === 'github.workflow_finished') {
    assertWorkflowRunFilters(trigger)
    return
  }
  if (trigger.source !== 'github' || !PR_STATE_EVENT_KINDS.includes(trigger.event)) {
    return
  }
  if (!trigger.subject) {
    throw new Error(`${name} follows one pull request: name it with subject=<owner/repo#n>.`)
  }
  if (trigger.from?.length || trigger.fromOwner) {
    throw new Error(`${name} is a pull request's state, which nobody does: leave out from=.`)
  }
}

/** What github.workflow_finished takes: the one run (run=, which names its repo too) and contains=. */
function assertWorkflowRunFilters(trigger: AutomationConnectorEventTrigger): void {
  if (!trigger.run || !/^\d{1,20}$/.test(trigger.run) || trigger.in?.length !== 1) {
    throw new Error(
      'github.workflow_finished waits on one run: name it with run=<its link, https://github.com/<owner>/<repo>/actions/runs/<id>>.'
    )
  }
  assertWorkflowRepoRef(trigger.in[0])
  if (trigger.subject || trigger.from?.length || trigger.fromOwner || trigger.onOwnerMessage) {
    throw new Error(
      'github.workflow_finished takes only run= and contains=: the run names its repo, and whoever started it, its result is heard.'
    )
  }
}

/** A run watch needs one repository id, never a whole installation or a thread. */
export function assertWorkflowRepoRef(place: string): void {
  if (!/^github:\d{1,32}:\d{1,32}$/.test(place)) {
    throw new Error(
      'github.workflow_finished needs a resolved repo ref for in=; use the exact run link to name its repository.'
    )
  }
}

export const WORKFLOW_WAIT_NEEDS_DEADLINE =
  'github.workflow_finished is a wait with a deadline: add --once --by <when the run should be done, plus a margin>, so it still wakes then if the event never comes.'

/** A finished run is heard only live, so a wait on one always has its deadline to fall back on. */
export function assertWorkflowWait(
  trigger: AutomationEventTrigger,
  automation: Pick<Automation, 'once'>
): void {
  if (needsWorkflows(trigger) && automation.once?.by === undefined) {
    throw new Error(WORKFLOW_WAIT_NEEDS_DEADLINE)
  }
}
