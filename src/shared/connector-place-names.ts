// Places as rules and results named them before refs: ids and keys the cloud matches by name. Where
// the host's Orca Cloud takes refs, the host turns these and any link or #name into refs instead.
import type { AutomationConnectorEventTrigger } from './automation-event-triggers'
import { LINEAR_ISSUE_KEY_PATTERN } from './connector-bot-linear-contract'

type PlaceSource = AutomationConnectorEventTrigger['source']

export const LEGACY_PLACE_WORDS: Record<PlaceSource, string> = {
  slack: 'Slack channel ids (C0123ABCD) or pasted channel links',
  github: 'repos as owner/name',
  linear: 'Linear team keys (ENG)'
}

// A name in place of an id would never match, so the rule would silently never start.
const LEGACY_PLACE_PATTERNS: Record<PlaceSource, RegExp> = {
  slack: /^[CGD][A-Z0-9]+$/i,
  github: /^[\w.-]+\/[\w.-]+$/,
  linear: /^[A-Za-z0-9]{1,16}$/
}

// A pasted link: <team>.slack.com/archives/C0123ABCD[/p...] or app.slack.com/client/T0123/C0123ABCD.
const SLACK_CHANNEL_LINK =
  /^https?:\/\/[\w.-]*slack\.com\/(?:archives|client\/[A-Z0-9]+)\/([CGD][A-Z0-9]+)(?:[/?#]|$)/i

/** The channel id a pasted Slack channel or message link names; anything else as written. */
export function slackChannelIdOf(place: string): string {
  return SLACK_CHANNEL_LINK.exec(place)?.[1] ?? place
}

/** A rule's place as written before refs, in its one spelling; null when it isn't one. */
export function legacyPlaceOf(source: PlaceSource, raw: string): string | null {
  const place = source === 'slack' ? slackChannelIdOf(raw.trim()) : raw.trim()
  if (!LEGACY_PLACE_PATTERNS[source].test(place)) {
    return null
  }
  // Slack ids are upper case and GitHub names any case, so one rule has one spelling.
  return source === 'slack'
    ? place.toUpperCase()
    : source === 'github'
      ? place.toLowerCase()
      : place
}

// One thread, issue or pull request, as rules named it before refs.
const LEGACY_SUBJECT_PATTERNS: Record<PlaceSource, RegExp> = {
  slack: /^[A-Z0-9]+:[CGD][A-Z0-9]+:\d+\.\d+$/i,
  github: /^[\w.-]+\/[\w.-]+#\d+$/,
  linear: LINEAR_ISSUE_KEY_PATTERN
}

export const LEGACY_SUBJECT_WORDS: Record<PlaceSource, string> = {
  slack: 'one thread, as team:channel:ts',
  github: 'one issue or pull request, as owner/name#482',
  linear: 'one issue, as ENG-123'
}

/** A rule's subject as written before refs; null when it isn't one. */
export function legacySubjectOf(source: PlaceSource, raw: string): string | null {
  const subject = raw.trim()
  if (!LEGACY_SUBJECT_PATTERNS[source].test(subject)) {
    return null
  }
  return source === 'github' ? subject.toLowerCase() : subject
}

/** A result's channel or Linear issue as written before refs; null when it isn't one. */
export function legacyResultPlaceOf(kind: 'channel' | 'linearIssue', raw: string): string | null {
  if (kind === 'linearIssue') {
    return LINEAR_ISSUE_KEY_PATTERN.test(raw.trim()) ? raw.trim() : null
  }
  return legacyPlaceOf('slack', raw)
}

/** Whether the value is already a ref of the source; past its prefix only the cloud reads it. */
export function isRefOf(source: string, value: string): boolean {
  return value.startsWith(`${source}:`)
}
