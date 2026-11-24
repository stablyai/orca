// Built-in template words as the template pages show them, in the UI language, under named keys
// (`bots.templates.<id>.<field>`). Bots made from a template keep the English: display words only.
import { BOT_TEMPLATES, type BotTemplate, type BotTemplateSkill } from './bot-templates'
import { BOT_TEMPLATE_SKILL_LINES, botTemplateEventParts, freeBotName } from './bot-template-view'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

type BotTemplateField =
  | 'name'
  | 'line'
  | 'firstChat'
  | 'watches'
  | 'does'
  | 'reports'
  | 'needsSetup'
  | 'example1'
  | 'example2'
type BotTemplateSchedule = BotTemplate['schedules'][number]
type BotTemplateEvent = BotTemplate['events'][number]

const scheduleKey = (schedule: BotTemplateSchedule, part: 'when' | 'what'): string =>
  `schedules.${schedule.id}.${part}`
const eventKey = (event: BotTemplateEvent, part: 'trigger' | 'action'): string =>
  `events.${event.id}.${part}`

/** Each English template word with its key under `bots.templates.<id>.`. */
export function botTemplateTextKeys(template: BotTemplate): [key: string, english: string][] {
  const fields: [string, string | undefined][] = [
    ['name', template.name],
    ['line', template.line],
    ['firstChat', template.firstChat],
    ['watches', template.watches],
    ['does', template.does],
    ['reports', template.reports],
    ['needsSetup', template.needsSetup],
    ['example1', template.example[0]],
    ['example2', template.example[1]],
    ...template.schedules.flatMap((schedule): [string, string][] => [
      [scheduleKey(schedule, 'when'), schedule.when],
      [scheduleKey(schedule, 'what'), schedule.what]
    ]),
    ...template.events.flatMap((event): [string, string | undefined][] => {
      const parts = botTemplateEventParts(event.name)
      return [
        [eventKey(event, 'trigger'), parts.trigger],
        [eventKey(event, 'action'), parts.action ?? undefined]
      ]
    })
  ]
  return fields.flatMap(([field, english]): [string, string][] =>
    english ? [[`${template.id}.${field}`, english]] : []
  )
}

const shown = (template: BotTemplate, field: string, english: string, t: Translate): string =>
  t(`bots.templates.${template.id}.${field}`, english)

/** One of a template's own words in the UI language. */
export function botTemplateWord(
  template: BotTemplate,
  field: BotTemplateField,
  t: Translate
): string {
  const english =
    field === 'example1'
      ? template.example[0]
      : field === 'example2'
        ? template.example[1]
        : (template[field] ?? '')
  return english ? shown(template, field, english, t) : english
}

export function botTemplateScheduleWords(
  template: BotTemplate,
  schedule: BotTemplateSchedule,
  t: Translate
): { when: string; what: string } {
  return {
    when: shown(template, scheduleKey(schedule, 'when'), schedule.when, t),
    what: shown(template, scheduleKey(schedule, 'what'), schedule.what, t)
  }
}

/** A template event's trigger and action, each translated after the English split. */
export function botTemplateEventWords(
  template: BotTemplate,
  event: BotTemplateEvent,
  t: Translate
): { trigger: string; action: string | null } {
  const parts = botTemplateEventParts(event.name)
  return {
    trigger: shown(template, eventKey(event, 'trigger'), parts.trigger, t),
    action:
      parts.action === null ? null : shown(template, eventKey(event, 'action'), parts.action, t)
  }
}

// Why by English: offer cards, SOUL.md descriptions and New bot's fields hold only the words; text
// that matches no template word stays as written. Words two templates share read as the first's.
const KEY_BY_ENGLISH = new Map<string, string>()
for (const [key, english] of BOT_TEMPLATES.flatMap(botTemplateTextKeys)) {
  if (!KEY_BY_ENGLISH.has(english)) {
    KEY_BY_ENGLISH.set(english, key)
  }
}

/** A built-in template's words, found by their English, in the UI language. */
export function botTemplateText(english: string, t: Translate): string {
  const key = KEY_BY_ENGLISH.get(english)
  return key ? t(`bots.templates.${key}`, english) : english
}

/** What a template skill teaches, as the template pages list it. */
export function botTemplateSkillLine(skill: BotTemplateSkill, t: Translate): string {
  return t(`bots.templateSkills.lines.${skill}`, BOT_TEMPLATE_SKILL_LINES[skill])
}

/** A template skill as the pages list it: a translated name keeps its folder name beside it; English
 *  shows the folder name the bot gets. */
export function botTemplateSkillName(skill: BotTemplateSkill, t: Translate): string {
  const name = translatedSkillName(skill, t)
  return name === skill
    ? skill
    : t('bots.templateSkills.nameWithFolder', '{{name}} ({{folder}})', { name, folder: skill })
}

function translatedSkillName(skill: BotTemplateSkill, t: Translate): string {
  switch (skill) {
    case 'pr-review-checklist':
      return t('bots.templateSkills.prReviewChecklist', 'pr-review-checklist')
    case 'review-with-ocr':
      return t('bots.templateSkills.reviewWithOcr', 'review-with-ocr')
    case 'bug-reproduction':
      return t('bots.templateSkills.bugReproduction', 'bug-reproduction')
    case 'ci-failure-triage':
      return t('bots.templateSkills.ciFailureTriage', 'ci-failure-triage')
    case 'release-readiness':
      return t('bots.templateSkills.releaseReadiness', 'release-readiness')
    case 'release-notes-style':
      return t('bots.templateSkills.releaseNotesStyle', 'release-notes-style')
    case 'dependency-upgrade':
      return t('bots.templateSkills.dependencyUpgrade', 'dependency-upgrade')
    case 'security-checklist':
      return t('bots.templateSkills.securityChecklist', 'security-checklist')
    case 'issue-triage':
      return t('bots.templateSkills.issueTriage', 'issue-triage')
    case 'feedback-themes':
      return t('bots.templateSkills.feedbackThemes', 'feedback-themes')
    case 'status-brief':
      return t('bots.templateSkills.statusBrief', 'status-brief')
    case 'spec-format':
      return t('bots.templateSkills.specFormat', 'spec-format')
    case 'incident-timeline':
      return t('bots.templateSkills.incidentTimeline', 'incident-timeline')
    case 'workspace-hygiene':
      return t('bots.templateSkills.workspaceHygiene', 'workspace-hygiene')
  }
}

/** A new bot's name from a template: the name the UI shows, free among `taken`. Kept as proposed,
 *  its folder is still named from the template's English name (templateBotFolderName). */
export function botTemplateBotName(
  template: BotTemplate,
  taken: readonly string[],
  t: Translate
): string {
  return freeBotName(botTemplateWord(template, 'name', t), taken)
}

/** A template's skills, automations and schedules as the pages list them, in the UI language. */
export function botTemplatePartWords(template: BotTemplate, t: Translate) {
  return {
    skills: template.skills.map((skill) => ({
      skill,
      name: botTemplateSkillName(skill, t),
      line: botTemplateSkillLine(skill, t)
    })),
    events: template.events.map((event) => ({
      id: event.id,
      ...botTemplateEventWords(template, event, t)
    })),
    schedules: template.schedules.map((schedule) => ({
      id: schedule.id,
      ...botTemplateScheduleWords(template, schedule, t)
    }))
  }
}
