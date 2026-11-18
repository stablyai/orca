// What the template pages (desktop and phone) show of a template, worked out once: the category groups,
// what a row says it runs on, and what a search matches.
import {
  BOT_CONNECTOR_NAMES,
  BOT_TEMPLATE_CATEGORIES,
  BOT_TEMPLATES,
  type BotTemplate,
  type BotTemplateCategory,
  type BotTemplateSkill
} from './bot-templates'

/** What each of our skills teaches, as the template pages list it. */
export const BOT_TEMPLATE_SKILL_LINES: Record<BotTemplateSkill, string> = {
  'pr-review-checklist':
    'Read a diff for behaviour changes, missing tests and risky edits; cite each finding.',
  'bug-reproduction': 'Write down the exact steps that show the bug before looking for its cause.',
  'ci-failure-triage':
    'Tell a flaky check from a real failure or broken infrastructure, and find the commit that started it.',
  'release-readiness': 'What blocks a release and how to list it: checks, reviews, open blockers.',
  'release-notes-style':
    'Notes for users: new, fixed, changed; leave out refactors and code names.',
  'dependency-upgrade':
    'Upgrade one group at a time, read the changelog, run the tests, one pull request each.',
  'security-checklist':
    'Secrets, injection, auth checks and unsafe defaults to look for in a change.',
  'issue-triage': 'Label, find duplicates, ask for missing repro details in one comment.',
  'feedback-themes':
    'Group feedback into themes with counts and short quotes; link existing issues.',
  'status-brief': 'Changed, blocked, needs a decision: a brief in under ten lines.',
  'spec-format': 'A one-page spec: problem, decision, scope, open questions.',
  'incident-timeline': 'Keep a timestamped timeline, then draft a blameless write-up.',
  'workspace-hygiene':
    'When a workspace is done or abandoned, and what to check before removing it.'
}

/** When a template's bot runs: its first schedule, its events, or only when asked. */
export type BotTemplateWhen =
  | { kind: 'schedule'; short: string }
  | { kind: 'events' }
  | { kind: 'asked' }

export function botTemplateWhen(template: BotTemplate): BotTemplateWhen {
  const first = template.schedules[0]
  if (first) {
    return { kind: 'schedule', short: first.short }
  }
  return template.events.length > 0 ? { kind: 'events' } : { kind: 'asked' }
}

/** What it connects, for a row: "GitHub", "Slack +1"; null for none. */
export function botTemplateConnectsLine(template: BotTemplate): string | null {
  const names = [
    ...template.connectors.map((kind) => BOT_CONNECTOR_NAMES[kind]),
    ...(template.events.some((event) => event.source === 'webhook') ? ['Webhook'] : [])
  ]
  const [first, ...rest] = names
  if (!first) {
    return null
  }
  return rest.length > 0 ? `${first} +${rest.length}` : first
}

/** A template event's name split into its trigger and what it does ("…: review it and post here"). */
export function botTemplateEventParts(name: string): { trigger: string; action: string | null } {
  const at = name.indexOf(': ')
  if (at === -1) {
    return { trigger: name, action: null }
  }
  const action = name.slice(at + 2)
  return { trigger: name.slice(0, at), action: action[0]?.toUpperCase() + action.slice(1) }
}

/** Whether a template matches a search: its name, line, category, connectors and skills. */
export function botTemplateMatches(
  template: BotTemplate,
  query: string,
  categoryLabel: (category: BotTemplateCategory) => string
): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return true
  }
  const text = [
    template.name,
    template.line,
    categoryLabel(template.category),
    ...template.connectors.map((kind) => BOT_CONNECTOR_NAMES[kind]),
    ...template.skills
  ]
    .join(' ')
    .toLowerCase()
  return words.every((word) => text.includes(word))
}

/** The catalog in its category order, each category with the templates the search kept. */
export function botTemplateGroups(
  matches: (template: BotTemplate) => boolean
): { category: BotTemplateCategory; templates: BotTemplate[] }[] {
  return BOT_TEMPLATE_CATEGORIES.map((category) => ({
    category,
    templates: BOT_TEMPLATES.filter(
      (template) => template.category === category && matches(template)
    )
  })).filter((group) => group.templates.length > 0)
}

/** The template's name, or "Name 2", "Name 3"… when a bot already has it. */
export function freeBotName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((entry) => entry.trim().toLowerCase()))
  if (!used.has(name.toLowerCase())) {
    return name
  }
  for (let index = 2; ; index++) {
    const candidate = `${name} ${index}`
    if (!used.has(candidate.toLowerCase())) {
      return candidate
    }
  }
}
