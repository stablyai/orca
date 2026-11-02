import {
  isBundledSkillLeaveReason,
  type BundledSkillInstallResult,
  type BundledSkillPlan
} from '../../../../shared/bundled-skill-plan'
import {
  summarizeBundledSkillOutcomes,
  type BundledSkillOutcomeText
} from '../../../../shared/bundled-skill-summary'
import { collapseHomePath } from '../../../../shared/bundled-skill-locations'
import { leaveReasonText, locationPlaceLabel, skillOutcomeText } from '../skills/skill-plan-op-copy'
import {
  bundledSkillSetupResultHeadline,
  type BundledSkillSetupChanges
} from './bundled-skill-setup-copy'
import { translate } from '@/i18n/i18n'
import { dirname } from '@/lib/path'

const RESULT_HEADLINE_ORDER: readonly BundledSkillOutcomeText[] = [
  'Needs attention',
  'Updated',
  'Installed',
  'Linked'
]

export function bundledSkillSetupAttentionMessage(plan: BundledSkillPlan): string {
  const blocked = plan.skills
    .flatMap((entry) => entry.ops)
    .find(
      (op) =>
        op.kind === 'leave' && !op.replaceable && op.reason && isBundledSkillLeaveReason(op.reason)
    )
  switch (blocked?.reason) {
    case 'unwritable':
      return translate(
        'auto.components.settings.bundledSkillSetupCopy.attentionUnwritable',
        "Needs attention · Orca can't write to {{folder}}",
        { folder: collapseHomePath(dirname(blocked.path), plan.homeDirectory) }
      )
    case 'busy':
      return translate(
        'auto.components.settings.bundledSkillSetupCopy.attentionBusy',
        'Needs attention · Another skill install is still finishing here'
      )
    case 'unreadable':
      return translate(
        'auto.components.settings.bundledSkillSetupCopy.attentionUnreadable',
        "Needs attention · Orca can't read every file in this copy"
      )
    case 'edited':
      return translate(
        'auto.components.settings.bundledSkillSetupCopy.attentionEdited',
        'Needs attention · You edited this copy'
      )
    case 'other':
      return translate(
        'auto.components.settings.bundledSkillSetupCopy.attentionOther',
        'Needs attention · A different skill already uses this name'
      )
    case 'shared-not-current':
      return translate(
        'auto.components.settings.bundledSkillSetupCopy.attentionSharedNotCurrent',
        'Needs attention · The shared copy this folder uses is not Orca’s'
      )
    case undefined:
      return translate('auto.components.skills.skillPlanOpCopy.needsAttention', 'Needs attention')
  }
}

export function skillInstallResultLine(
  result: BundledSkillInstallResult,
  changes?: BundledSkillSetupChanges
): string {
  const summary = summarizeBundledSkillOutcomes(result)
  const texts = new Set(summary.skills.map((skill) => skill.text))
  const headlineText = RESULT_HEADLINE_ORDER.find((text) => texts.has(text)) ?? 'No change'
  const outcome = result.skills.find((_, index) => summary.skills[index].text === headlineText)
  const headline =
    changes && summary.ok && !texts.has('Needs attention')
      ? bundledSkillSetupResultHeadline(changes)
      : outcome
        ? skillOutcomeText(outcome)
        : translate('auto.components.skills.skillPlanOpCopy.keep', 'No change')
  const notUpdated = summary.skills.flatMap((skill) => skill.leftAlone)
  if (notUpdated.length === 0) {
    return headline
  }
  const reasons = [...new Set(notUpdated.map((left) => left.code))]
    .map((reason) => leaveReasonText(reason))
    .join('; ')
  if (notUpdated.length > 1) {
    return translate(
      'auto.components.settings.bundledSkillSetupCopy.resultUpdateSkippedPlaces',
      '{{result}} · Update skipped in {{places}} places: {{reason}}',
      { result: headline, places: notUpdated.length, reason: reasons }
    )
  }
  const location = changes?.notUpdated.find((location) => location.path === notUpdated[0].path)
  return translate(
    'auto.components.settings.bundledSkillSetupCopy.resultUpdateSkippedAgent',
    '{{result}} · Update skipped in {{agent}}: {{reason}}',
    {
      result: headline,
      agent: location ? locationPlaceLabel(location) : notUpdated[0].path,
      reason: reasons
    }
  )
}
