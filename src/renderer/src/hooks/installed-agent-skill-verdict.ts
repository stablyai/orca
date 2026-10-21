import type { SkillDiscoverySource, SkillSourceKind } from '../../../shared/skills'
import { translate } from '@/i18n/i18n'

/**
 * True when a root this query cares about did not answer, so its skills are
 * unknown rather than absent. The host serves such a root's last answer, but a
 * root that has never answered has none to serve, and a bare "Not installed"
 * there offers Install for a skill that may already be present.
 */
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

/**
 * Finding the skill is proof, so only a negative is ever doubted. Two shapes
 * qualify: a scan that answered without reading a root this query cares about,
 * and a scan that never answered at all — invisible to `sources`, which stay
 * empty until a result lands. A failed refresh over an answer already held is
 * neither: that answer still stands.
 */
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
