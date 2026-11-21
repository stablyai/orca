// Built-in template words as the template pages show them, in the UI language. Keys hash the English,
// so a catalog edit shows its new English until it is translated again, never a stale translation.
// Bots made from a template keep the English: these are display words only.
import type { BotProposal } from './bot-proposal'
import { botTemplate, type BotTemplateSkill } from './bot-templates'
import { botTemplateEventParts, freeBotName } from './bot-template-view'
import { englishTextHash } from '../text/english-text-hash'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

export function botTemplateText(english: string, t: Translate): string {
  // Why the inline template: catalog checks keep keys whose `t(` call names this prefix.
  return english ? t(`bots.templateText.t${englishTextHash(english)}`, english) : english
}

/** A template's proposed name as New bot shows it: in the UI language and free among `taken`; any
 *  other name as typed. Left as shown, the bot is made under the English name, which names its
 *  folder, its Linear and GitHub handle and its SOUL.md, and then takes this one. */
/** The template's own name, or that name with the number that keeps it free ("Support triage 2"). */
function isTemplateDefaultName(name: string, templateName: string): boolean {
  return (
    name === templateName ||
    (name.startsWith(`${templateName} `) && /^\d+$/.test(name.slice(templateName.length + 1)))
  )
}

export function botTemplateShownName(
  proposal: Pick<BotProposal, 'name' | 'templateId'> | null | undefined,
  name: string,
  taken: readonly string[],
  t: Translate
): string {
  const template = botTemplate(proposal?.templateId)
  if (!template || name !== proposal?.name || !isTemplateDefaultName(name, template.name)) {
    return name
  }
  const translated = botTemplateText(template.name, t)
  return translated === template.name ? name : freeBotName(translated, taken)
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

/** A template event's trigger and action, each translated after the English split. */
export function botTemplateEventWords(
  name: string,
  t: Translate
): { trigger: string; action: string | null } {
  const parts = botTemplateEventParts(name)
  return {
    trigger: botTemplateText(parts.trigger, t),
    action: parts.action === null ? null : botTemplateText(parts.action, t)
  }
}
