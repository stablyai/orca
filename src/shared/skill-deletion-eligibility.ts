import type { SkillDeleteBlockReason } from './skill-delete-contract'
import type { DiscoveredSkill, SkillSourceKind } from './skills'

export type SkillDeletionEligibility =
  | { deletable: true }
  | { deletable: false; reason: SkillDeleteBlockReason; message: string }

/** English defaults. The renderer translates by reason code; logs and the CLI
 *  use these directly. */
export const SKILL_DELETE_BLOCK_MESSAGES: Record<SkillDeleteBlockReason, string> = {
  bundled: 'Bundled with Orca — it would be restored',
  plugin: 'Installed by a plugin — remove the plugin instead',
  unowned: 'This skill lives outside Orca’s skill folders — delete it where it is stored',
  missing: 'This skill is no longer on disk',
  stale: 'This skill changed since the list was loaded — refresh and try again'
}

function blocked(reason: SkillDeleteBlockReason): SkillDeletionEligibility {
  return { deletable: false, reason, message: SKILL_DELETE_BLOCK_MESSAGES[reason] }
}

/**
 * Client-side predicate over the displayed row.
 *
 * Advisory for `bundled`/`plugin`: `sourceKind` is first-scanned-root-wins, so a
 * plugin-cache skill symlinked into a plain home root reports `home` here. The
 * host re-derives the verdict from the placement set and can be stricter.
 */
export function skillDeletionEligibility(
  skill: Pick<DiscoveredSkill, 'sourceKind'>
): SkillDeletionEligibility {
  return skillSourceKindDeletionEligibility(skill.sourceKind)
}

export function skillSourceKindDeletionEligibility(
  sourceKind: SkillSourceKind
): SkillDeletionEligibility {
  switch (sourceKind) {
    case 'bundled': {
      return blocked('bundled')
    }
    case 'plugin': {
      return blocked('plugin')
    }
    case 'home':
    case 'repo': {
      return { deletable: true }
    }
  }
}

export function isSkillDeletable(skill: Pick<DiscoveredSkill, 'sourceKind'>): boolean {
  return skillDeletionEligibility(skill).deletable
}
