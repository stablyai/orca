import {
  isBundledSkillLeaveReason,
  type BundledSkillOutcome,
  type BundledSkillPlan
} from '../../../../../shared/bundled-skill-plan'
import type {
  BundledSkillLocation,
  BundledSkillLocationState
} from '../../../../../shared/bundled-skill-locations'
import {
  bundledSkillInstallAgents,
  bundledSkillOutcomeText,
  summarizeBundledSkillPlan,
  type BundledSkillPlanState,
  type BundledSkillResultSummary
} from '../../../../../shared/bundled-skill-summary'
import { SKILL_INSTALL_PROVIDERS } from '../../../../../shared/skill-install-providers'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function updatedSkillsLabel(
  summary: BundledSkillResultSummary,
  t: Translate = translate
): string {
  const { changedCount, leftAloneCount } = summary
  const updated = t(
    'auto.components.skills.SkillFreshnessUpdateDialog.updated',
    'Updated {{count}} skills',
    { count: changedCount, defaultValue_one: 'Updated {{count}} skill' }
  )
  return leftAloneCount > 0
    ? t(
        'auto.components.skills.SkillFreshnessUpdateDialog.updatedSkipped',
        '{{value0}} · {{value1}} skipped',
        { value0: updated, value1: leftAloneCount }
      )
    : updated
}

/** Translated reason Orca left a location alone; unknown reasons from newer hosts fall back. */
export function leaveReasonText(
  reason: string | null | undefined,
  t: Translate = translate
): string {
  if (!reason || !isBundledSkillLeaveReason(reason)) {
    return t('auto.components.skills.skillPlanOpCopy.leftAsIs', 'This copy was kept as it is')
  }
  switch (reason) {
    case 'edited':
      return t('auto.components.skills.skillPlanOpCopy.edited', 'Skill edited outside Orca')
    case 'other-build':
      return t(
        'auto.components.skills.skillPlanOpCopy.otherBuild',
        'Installed by another Orca version'
      )
    case 'other':
      return t('auto.components.skills.skillPlanOpCopy.other', 'A different skill uses this name')
    case 'unwritable':
      return t(
        'auto.components.skills.skillPlanOpCopy.unwritable',
        "Orca can't write to this folder"
      )
    case 'unreadable':
      return t('auto.components.skills.skillPlanOpCopy.unreadable', "Orca can't read every file")
    case 'busy':
      return t('auto.components.skills.skillPlanOpCopy.busy', 'Another install is still running')
    case 'shared-not-current':
      return t(
        'auto.components.skills.skillPlanOpCopy.sharedNotCurrent',
        "The shared copy isn't Orca's"
      )
  }
}

export function locationPlaceLabel(
  location: BundledSkillLocation,
  t: Translate = translate
): string {
  if (location.place.kind === 'shared') {
    return t('auto.components.skills.skillPlanOpCopy.sharedFolder', 'Shared folder')
  }
  return location.place.names.join(', ') || location.displayPath
}

export function locationStateText(location: BundledSkillLocation): string {
  const texts: Record<BundledSkillLocationState, () => string> = {
    update: () => translate('auto.components.skills.skillPlanOpCopy.update', 'Update'),
    repair: () => translate('auto.components.skills.skillPlanOpCopy.repair', 'Repair'),
    install: () => translate('auto.components.skills.skillPlanOpCopy.write', 'Install'),
    link: () => translate('auto.components.skills.skillPlanOpCopy.link', 'Link'),
    replace: () => translate('auto.components.skills.skillPlanOpCopy.replace', 'Replace'),
    keep: () => translate('auto.components.skills.skillPlanOpCopy.keep', 'No change'),
    'keep-link': () =>
      translate('auto.components.skills.skillPlanOpCopy.keepLink', 'Link, no change'),
    leave: () =>
      // Another build's copy was never meant to update, so it is kept rather than skipped.
      location.reason === 'other-build'
        ? translate(
            'auto.components.skills.skillPlanOpCopy.otherBuildKept',
            'Kept: written by another Orca version'
          )
        : translate(
            'auto.components.skills.skillPlanOpCopy.updateSkipped',
            'Update skipped: {{value0}}',
            {
              value0: leaveReasonText(location.reason)
            }
          ),
    unknown: () =>
      translate('auto.components.skills.skillPlanOpCopy.needsAttention', 'Needs attention')
  }
  return texts[location.state]()
}

/** The skill row's line before Update runs; null when only its locations need saying. */
export function skillPlanHeadline(
  state: BundledSkillPlanState,
  t: Translate = translate
): string | null {
  switch (state) {
    case 'update':
      return t('auto.components.skills.skillPlanOpCopy.updateAvailable', 'Update available')
    case 'repair':
      return t('auto.components.skills.skillPlanOpCopy.repairAvailable', 'Repair available')
    case 'install':
      return t('auto.components.skills.skillPlanOpCopy.installAvailable', 'Install available')
    case 'attention':
    case 'current':
      return null
  }
}

export function skillOutcomeText(outcome: BundledSkillOutcome, t: Translate = translate): string {
  const text = bundledSkillOutcomeText(outcome)
  switch (text) {
    case 'Updated':
      if (outcome.ops.some((op) => op.kind === 'replace' && op.status === 'done')) {
        return t(
          'auto.components.skills.skillPlanOpCopy.replacedWithBackup',
          'Replaced · Your copy was saved as a backup'
        )
      }
      return t('auto.components.skills.skillPlanOpCopy.updated', 'Updated')
    case 'Installed':
      return t('auto.components.skills.skillPlanOpCopy.installed', 'Installed')
    case 'Linked':
      return t('auto.components.skills.skillPlanOpCopy.linked', 'Linked')
    case 'No change':
      return t('auto.components.skills.skillPlanOpCopy.keep', 'No change')
    case 'Needs attention':
      return t('auto.components.skills.skillPlanOpCopy.needsAttention', 'Needs attention')
  }
}

export function agentNames(agents: readonly string[]): string {
  return agents
    .map((agent) => SKILL_INSTALL_PROVIDERS.find((provider) => provider.id === agent)?.displayName)
    .filter((name): name is string => Boolean(name))
    .join(', ')
}

export function installForAgentsLabel(agents: readonly string[], t: Translate = translate): string {
  const names = agentNames(agents)
  if (!names) {
    return t('auto.components.skills.skillPlanOpCopy.install', 'Install')
  }
  return t('auto.components.skills.skillPlanOpCopy.installFor', 'Install for {{value0}}', {
    value0: names
  })
}

/** The Update button's label: an update when any skill needs one, else the agents it links. */
export function updateActionLabel(plan: BundledSkillPlan, t: Translate = translate): string {
  const summary = summarizeBundledSkillPlan(plan)
  const updates = summary.skills.filter(
    (skill) => skill.state === 'update' || skill.state === 'repair'
  ).length
  if (updates === 0) {
    const agents = bundledSkillInstallAgents(plan.skills)
    return agents.length > 0
      ? installForAgentsLabel(agents, t)
      : t('auto.components.skills.SkillFreshnessUpdateDialog.title', 'Update skills')
  }
  return t(
    'auto.components.skills.SkillFreshnessUpdateDialog.updateAction',
    'Update {{count}} skills',
    { count: updates, defaultValue_one: 'Update {{count}} skill' }
  )
}
