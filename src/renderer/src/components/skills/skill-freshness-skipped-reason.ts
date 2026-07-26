import type { SkillLocationChip, SkillLocationRow } from './skill-freshness-grouping'
import { translate } from '@/i18n/i18n'

// Why: a skill is skipped for one concrete reason; lead with the highest-priority
// blocking placement so the sentence explains the real cause (an edited copy is
// more useful to surface than a downstream symptom).
const SKIPPED_REASON_PRIORITY: SkillLocationChip[] = [
  'unrecognized',
  'read-only',
  'inaccessible',
  'in-a-repo',
  'plugin-cache',
  'external-link',
  'broken-link',
  // Why: lowest priority — a stale duplicate only explains the skip once no
  // harder blocker is present, since the others describe a more specific cause.
  'duplicate'
]

function blockingChip(locations: readonly SkillLocationRow[]): SkillLocationChip | undefined {
  const present = new Set(locations.map((location) => location.chip))
  return SKIPPED_REASON_PRIORITY.find((candidate) => present.has(candidate))
}

/**
 * The one sentence that explains why an update won't reach a skill. Shared by the
 * review dialog and the setup rails so the badge and the dialog can never disagree.
 *
 * The wording is deictic ("this copy") on purpose: it is only ever rendered beside the
 * location rows it describes, which is why the setup rails link into the dialog rather
 * than repeating a sentence that would have nothing to point at.
 */
export function skippedReason(locations: readonly SkillLocationRow[]): string {
  const chip = blockingChip(locations)
  switch (chip) {
    case 'unrecognized':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonUnrecognized',
        'The copy here doesn’t match the official version — it may be modified, or a different skill with the same name. Orca left it out of the update so it won’t overwrite it. Remove it if you want Orca to update this skill.'
      )
    case 'read-only':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonReadOnly',
        'This copy is in a read-only location, so Orca left it out of the update. Change its permissions to let Orca update it.'
      )
    case 'inaccessible':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonInaccessible',
        'Orca couldn’t read this copy, so it left the skill out of the update.'
      )
    case 'in-a-repo':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonInRepo',
        'This is a project skill, not a global one — Orca only updates your global skills, so it left this out of the update.'
      )
    case 'plugin-cache':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonPluginCache',
        'A plugin manages this skill, so Orca left it out of the update — update the plugin instead.'
      )
    case 'external-link':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonExternalLink',
        'This copy is a shortcut pointing outside Orca’s skill folders, so Orca left it out of the update.'
      )
    case 'broken-link':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonBrokenLink',
        'This copy is a shortcut to something that no longer exists, so Orca left it out — you can safely delete it.'
      )
    case 'duplicate':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonDuplicate',
        'This is a separate copy, so the update won’t reach it — the command only refreshes the main copy. Remove this copy, then reinstall the skill so this location follows the main one.'
      )
    // Why: 'current' is non-blocking and an empty priority list is possible;
    // both fall through to the generic skipped message.
    case 'current':
    case undefined:
      return translate(
        'auto.components.skills.SkillFreshnessRow.cantUpdateReason',
        'Orca left this skill out of the update command.'
      )
  }
}
