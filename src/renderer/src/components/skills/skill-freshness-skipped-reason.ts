import { buildAgentFeatureSkillInstallCommand } from '../../../../shared/agent-feature-install-commands'
import type { SkillLocationChip, SkillLocationRow } from './skill-freshness-grouping'
import { translate } from '@/i18n/i18n'

// Why: a skill is skipped for one concrete reason; lead with the highest-priority
// blocking placement so the sentence explains the real cause (an edited copy is
// more useful to surface than a downstream symptom).
const SKIPPED_REASON_PRIORITY: SkillLocationChip[] = [
  'unrecognized',
  'read-only',
  'inaccessible',
  // Why: above the placement chips — a copy that is ahead of this build must never
  // fall through to the reinstall advice below, which would roll it back.
  'newer',
  'in-a-repo',
  'plugin-cache',
  'external-link',
  'broken-link',
  // Why: lowest priority — a stale duplicate only explains the skip once no
  // harder blocker is present, since the others describe a more specific cause.
  'duplicate'
]

// Why: a location the global update never judged cannot be why the skill was skipped, so it
// must not outrank the placement that was — nor the ABSENCE of a chip, which is how the
// stale-record remedy below is reached. The fallback keeps the sentence total.
function blockingChip(locations: readonly SkillLocationRow[]): SkillLocationChip | undefined {
  const judged = locations.filter((location) => location.participatesInGlobalFreshness)
  const present = new Set((judged.length > 0 ? judged : locations).map((location) => location.chip))
  return SKIPPED_REASON_PRIORITY.find((candidate) => present.has(candidate))
}

/**
 * The one sentence that explains why an update won't reach a skill. Shared by the
 * review dialog and the setup rails so the badge and the dialog can never disagree.
 *
 * The wording is deictic ("this copy") on purpose: it is only ever rendered beside the
 * location rows it describes, which is why the setup rails link into the dialog rather
 * than repeating a sentence that would have nothing to point at.
 *
 * `skillName` is only used for the no-chip case, where the fault is not a placement at
 * all but the updater's own record of this skill, and the remedy has to name it.
 */
export function skippedReason(locations: readonly SkillLocationRow[], skillName?: string): string {
  const chip = blockingChip(locations)
  switch (chip) {
    case 'newer':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonNewer',
        'This copy is a later version than the one this build of Orca ships, so Orca left it alone rather than roll it back. Updating Orca will bring the two back in line.'
      )
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
    case 'current':
    case undefined:
      // Why: no location is at fault here — the copy is an ordinary out-of-date one the
      // update would happily write. What is wrong is the updater's own record of it:
      // `skills update` decides what to do by comparing that record against the source
      // and never reads disk, so when the record is missing or already names the version
      // it was meant to fetch, the command reports "up to date" and writes nothing. No
      // retry converges it; only a reinstall rewrites the record, which is why the
      // sentence has to hand over the command rather than say the update was skipped.
      return skillName
        ? translate(
            'auto.components.skills.SkillFreshnessRow.skippedReasonStaleRecord',
            'The skills updater has no usable record of this copy, so it reports the skill as already up to date and changes nothing. Reinstall it to bring the record back in line: {{value0}}',
            { value0: buildAgentFeatureSkillInstallCommand([skillName]) }
          )
        : translate(
            'auto.components.skills.SkillFreshnessRow.cantUpdateReason',
            'Orca left this skill out of the update command.'
          )
  }
}
