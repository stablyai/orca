// Where an event rule listens and whose events it takes, in words: the names saved with the rule,
// or plain words for a rule saved before names. Never a raw id.
import { getIntlLocale, translate } from '@/i18n/i18n'
import type { AutomationConnectorEventTrigger } from '../../../../shared/automation-event-triggers'
import type { AutomationGoogleTrigger } from '../../../../shared/automation-google-triggers'
import { isRefOf } from '../../../../shared/connector-place-names'

type Rule = Pick<
  AutomationConnectorEventTrigger,
  'source' | 'in' | 'subject' | 'from' | 'fromOwner' | 'names'
>

// Ids that read as themselves: "owner/name" repos, "ENG" teams, "ENG-42" or "owner/name#4" subjects.
function nameOf(rule: Rule, value: string): string | null {
  return (
    rule.names?.[value] ?? (rule.source !== 'slack' && !isRefOf(rule.source, value) ? value : null)
  )
}

function unnamedPlaces(source: Rule['source'], count: number): string {
  switch (source) {
    case 'slack':
      return translate('automations.botEvents.unnamed.slackChannel', '{{count}} Slack channels', {
        count,
        defaultValue_one: 'a Slack channel'
      })
    case 'github':
      return translate('automations.botEvents.unnamed.githubRepo', '{{count}} repositories', {
        count,
        defaultValue_one: 'a repository'
      })
    case 'linear':
      return translate('automations.botEvents.unnamed.linearTeam', '{{count}} Linear teams', {
        count,
        defaultValue_one: 'a Linear team'
      })
  }
}

/** Names first; the rest counted ("#orca and 1 more"), or wholly in words when none is named. */
function listed(names: string[], unnamed: number, unnamedWords: string): string {
  if (names.length === 0) {
    return unnamedWords
  }
  const joined = names.join(', ')
  return unnamed === 0
    ? joined
    : translate('automations.botEvents.andMore', '{{names}} and {{count}} more', {
        names: joined,
        count: unnamed
      })
}

/** People any one of whom starts it: "you or Dana", "you, Nora, or Dana"; the rest counted ("Nora
 *  or 2 others"), or wholly in words when none is named. */
function eitherOf(names: string[], unnamed: number, unnamedWords: string): string {
  if (names.length === 0) {
    return unnamedWords
  }
  const joined = new Intl.ListFormat(getIntlLocale(), { type: 'disjunction' }).format(names)
  return unnamed === 0
    ? joined
    : translate('automations.botEvents.orMore', '{{names}} or {{count}} others', {
        names: joined,
        count: unnamed,
        defaultValue_one: '{{names}} or {{count}} other'
      })
}

/** "in #orca", "in stablyai/orca", or "in a Slack channel" for a rule saved before names. */
export function placesPhrase(rule: Rule): string | null {
  if (!rule.in?.length) {
    return null
  }
  const names = rule.in.flatMap((place) => nameOf(rule, place) ?? [])
  const unnamed = rule.in.length - names.length
  return translate('automations.botEvents.in', 'in {{places}}', {
    places: listed(names, unnamed, unnamedPlaces(rule.source, unnamed))
  })
}

/** "in a thread in #orca" for a Slack thread; "on ENG-42" or "on stablyai/orca#12" otherwise. */
export function subjectPhrase(rule: Rule): string | null {
  if (!rule.subject) {
    return null
  }
  const name = nameOf(rule, rule.subject)
  if (rule.source === 'slack') {
    return name
      ? translate('automations.botEvents.slackThread', 'in a thread in {{channel}}', {
          channel: name
        })
      : translate('automations.botEvents.slackThreadUnnamed', 'in a thread in a Slack channel')
  }
  return translate('automations.botEvents.subject', 'on {{subject}}', {
    subject:
      name ??
      (rule.source === 'github'
        ? translate('automations.botEvents.unnamed.githubSubject', 'an issue or pull request')
        : translate('automations.botEvents.unnamed.linearSubject', 'a Linear issue'))
  })
}

/** "from Nora or Sam", "from you" for your own pull requests, or "from 2 people" for a rule saved
 *  before names. */
export function peoplePhrase(rule: Rule): string | null {
  const own = rule.fromOwner === true
  const from = rule.from ?? []
  if (from.length === 0 && !own) {
    return null
  }
  const names = [
    ...(own ? [translate('automations.botEvents.you', 'you')] : []),
    ...from.flatMap((person) => rule.names?.[person] ?? [])
  ]
  const unnamed = from.length + (own ? 1 : 0) - names.length
  return translate('automations.botEvents.from', 'from {{people}}', {
    people: eitherOf(
      names,
      unnamed,
      translate('automations.botEvents.unnamed.people', '{{count}} people', {
        count: unnamed,
        defaultValue_one: '{{count}} person'
      })
    )
  })
}

/** A Gmail or Calendar rule's filters: "from sam@x.com", "subject containing “invoice”", "10 min before". */
export function googleTriggerPhrases(rule: AutomationGoogleTrigger): string[] {
  if (rule.source === 'calendar') {
    return [
      translate('bots.automations.google.minutesBefore', '{{count}} min before', {
        count: rule.minutesBefore
      }),
      ...(rule.calendar
        ? [
            translate('bots.automations.google.calendar', 'on {{calendar}}', {
              calendar: rule.calendar
            })
          ]
        : [])
    ]
  }
  return [
    ...(rule.from?.length
      ? [translate('bots.automations.google.from', 'from {{who}}', { who: rule.from.join(', ') })]
      : []),
    ...(rule.to?.length
      ? [translate('bots.automations.google.to', 'to {{who}}', { who: rule.to.join(', ') })]
      : []),
    ...(rule.subjectContains
      ? [
          translate('bots.automations.google.subject', 'subject containing “{{text}}”', {
            text: rule.subjectContains
          })
        ]
      : []),
    ...(rule.label
      ? [translate('bots.automations.google.label', 'labelled {{label}}', { label: rule.label })]
      : [])
  ]
}
