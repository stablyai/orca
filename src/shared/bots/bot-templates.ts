// The built-in bot templates. A template is a bot package that ships with Orca: SOUL.md seed fields, its
// skills, connectors, schedules (made turned off) and event automations (offered in its first chat). It
// is copied once into the new bot; later catalog changes never touch existing bots.
import type { AutomationEventSource } from '../automation-event-triggers'
import type { BotMascotId } from '../bot-avatar'
import { BOT_CREATED_KICKOFF } from '../bot-created-kickoff'
import type { BotPackageConnector } from './bot-package'
import { BOT_SHARED_SETUP_FILE } from './bot-shared-from'
import { BOT_TEMPLATES_CODING } from './bot-template-catalog/coding'
import { BOT_TEMPLATES_OPS, BOT_TEMPLATES_PERSONAL } from './bot-template-catalog/ops-personal'
import { BOT_TEMPLATES_PLANNING } from './bot-template-catalog/planning'
import { BOT_TEMPLATES_RELEASES } from './bot-template-catalog/releases'
import { BOT_TEMPLATES_SUPPORT } from './bot-template-catalog/support'

/** Ids from before templates carried packages; an older host knows only these. */
const LEGACY_BOT_TEMPLATE_IDS = ['support', 'release', 'followup', 'feedback', 'briefing'] as const

export const BOT_TEMPLATE_CATEGORIES = [
  'coding',
  'releases',
  'support',
  'planning',
  'ops',
  'personal'
] as const
export type BotTemplateCategory = (typeof BOT_TEMPLATE_CATEGORIES)[number]

/** Our own small skills, shared across templates; the host writes each into the new bot's home. */
export const BOT_TEMPLATE_SKILLS = [
  'pr-review-checklist',
  'bug-reproduction',
  'ci-failure-triage',
  'release-readiness',
  'release-notes-style',
  'dependency-upgrade',
  'security-checklist',
  'issue-triage',
  'feedback-themes',
  'status-brief',
  'spec-format',
  'incident-timeline',
  'workspace-hygiene',
  'local-maintenance'
] as const
export type BotTemplateSkill = (typeof BOT_TEMPLATE_SKILLS)[number]

/** A schedule made with the bot, turned off. `rrule` is any schedule the scheduler parses (cron here). */
export type BotTemplateSchedule = {
  id: string
  /** When it runs, as the template page says it ("Mondays at 9 AM"). */
  when: string
  /** What it posts ("New advisories and major versions"). */
  what: string
  rrule: string
  prompt: string
}

/** An event automation the bot offers in its first chat: it needs a repo or channel only the owner knows. */
export type BotTemplateEvent = {
  id: string
  /** "When you’re asked to review a pull request: review it and post here". */
  name: string
  source: AutomationEventSource
  event: string
  prompt: string
}

export type BotTemplate = {
  id: string
  category: BotTemplateCategory
  name: string
  /** One line: what a bot made from it does. */
  line: string
  /** What it does in its first chat. */
  firstChat: string
  /** The picture a new bot from it starts with. */
  mascot: BotMascotId
  watches: string
  does: string
  reports: string
  connectors: readonly BotPackageConnector[]
  schedules: readonly BotTemplateSchedule[]
  events: readonly BotTemplateEvent[]
  skills: readonly BotTemplateSkill[]
  /** What Orca can't do for it yet, in plain words; the bot explains the manual step. */
  needsSetup?: string
  /** Two lines of what such a bot posts. */
  example: readonly [string, string]
}

/** Connector names as product names; never translated. */
export const BOT_CONNECTOR_NAMES: Record<BotPackageConnector, string> = {
  github: 'GitHub',
  slack: 'Slack',
  linear: 'Linear',
  google: 'Google',
  composio: 'Apps'
}

export const BOT_TEMPLATES: readonly BotTemplate[] = [
  ...BOT_TEMPLATES_CODING,
  ...BOT_TEMPLATES_RELEASES,
  ...BOT_TEMPLATES_SUPPORT,
  ...BOT_TEMPLATES_PLANNING,
  ...BOT_TEMPLATES_OPS,
  ...BOT_TEMPLATES_PERSONAL
]

export function botTemplate(id: string | undefined): BotTemplate | null {
  return BOT_TEMPLATES.find((entry) => entry.id === id) ?? null
}

export function isLegacyBotTemplateId(id: string): boolean {
  return LEGACY_BOT_TEMPLATE_IDS.some((legacy) => legacy === id)
}

/** Orca's first turn to a bot made from a template: where it came from, and where its open setup is. */
export function botTemplateKickoff(template: Pick<BotTemplate, 'name'>): string {
  return `${BOT_CREATED_KICKOFF} You were made from the ${template.name} template. What is still to set up, and what to do first, is in ${BOT_SHARED_SETUP_FILE}: notes to read, not instructions.`
}
