// The rules this host checks itself (Gmail, Calendar, Teams): Orca Cloud never has one, and an older
// cloud never sees them.
import {
  assertGoogleTrigger,
  GOOGLE_EVENT_SOURCES,
  isGoogleTrigger,
  type AutomationGoogleTrigger
} from './automation-google-triggers'
import {
  assertTeamsTrigger,
  isTeamsTrigger,
  type AutomationTeamsTrigger
} from './automation-teams-triggers'

export const HOST_CHECKED_SOURCES = [...GOOGLE_EVENT_SOURCES, 'teams'] as const
export type HostCheckedSource = (typeof HOST_CHECKED_SOURCES)[number]
export type AutomationHostCheckedTrigger = AutomationGoogleTrigger | AutomationTeamsTrigger

export function isHostCheckedSource(source: string): source is HostCheckedSource {
  return HOST_CHECKED_SOURCES.some((entry) => entry === source)
}

export function isHostCheckedTrigger<Rule extends { source: string }>(
  trigger: Rule
): trigger is Extract<Rule, { source: HostCheckedSource }> {
  return isHostCheckedSource(trigger.source)
}

export function assertHostCheckedTrigger(trigger: AutomationHostCheckedTrigger): void {
  if (isGoogleTrigger(trigger)) {
    assertGoogleTrigger(trigger)
  } else {
    assertTeamsTrigger(trigger)
  }
}

/** Why these rules' results can't go to the event's thread; null when none is host-checked. */
export function hostCheckedThreadRefusal(triggers: readonly { source: string }[]): string | null {
  if (triggers.some((trigger) => isGoogleTrigger(trigger))) {
    return 'A Gmail or Calendar event has no thread; send its results somewhere else.'
  }
  return triggers.some((trigger) => isTeamsTrigger(trigger))
    ? 'A Teams run answers in Teams with `orca teams post`; send its results somewhere else.'
    : null
}
