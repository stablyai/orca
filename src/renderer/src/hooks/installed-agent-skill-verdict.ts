import type { SkillDiscoverySource, SkillSourceKind } from '../../../shared/skills'
import { translate } from '@/i18n/i18n'

/** Unread roots mean unknown skills, not absent; a never-read root has no cached answer to prevent misleading Install actions. */
export function hasUnreadableAgentSkillSource(
  sources: readonly SkillDiscoverySource[],
  sourceKinds?: readonly SkillSourceKind[]
): boolean {
  return sources.some(
    (source) =>
      source.skippedReason === 'unavailable' &&
      (!sourceKinds || sourceKinds.includes(source.sourceKind))
  )
}

export type InstalledAgentSkillScan = {
  enabled: boolean
  installed: boolean
  /** A scan answered for this target; a cached answer counts. */
  settled: boolean
  /** The scan's own failure, before the advisory below is folded in. */
  error: string | null
  sources: readonly SkillDiscoverySource[]
  sourceKinds?: readonly SkillSourceKind[]
}

export type InstalledAgentSkillVerdict = {
  /** Nothing proves the skill absent, so no surface may render it as undone. */
  installedUnverifiable: boolean
  /** The scan's own failure, else the advisory an unverifiable negative earns. */
  error: string | null
}

/** Doubt negative scans with unread roots or no answer; positive findings and already-held answers remain evidence despite refresh failure. */
export function getInstalledAgentSkillVerdict(
  scan: InstalledAgentSkillScan
): InstalledAgentSkillVerdict {
  const installedUnverifiable =
    scan.enabled &&
    !scan.installed &&
    (hasUnreadableAgentSkillSource(scan.sources, scan.sourceKinds) ||
      (!scan.settled && scan.error !== null))
  return {
    installedUnverifiable,
    error:
      scan.error ??
      (installedUnverifiable
        ? translate(
            'auto.hooks.useInstalledAgentSkills.unreadableSkillSource',
            'A skill folder did not respond, so this status may be incomplete.'
          )
        : null)
  }
}
