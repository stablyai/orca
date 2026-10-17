import type {
  BundledSkillLeaveReason,
  BundledSkillLocationAction,
  BundledSkillLocationPlan,
  BundledSkillPlan,
  SkillFreshnessInventory
} from '../../../shared/skill-freshness'

// Test fixtures: plans as the installer would report them for a home at /home.

export function sharedLocation(
  name: string,
  action: BundledSkillLocationAction,
  reason?: BundledSkillLeaveReason
): BundledSkillLocationPlan {
  return {
    path: `/home/.agents/skills/${name}`,
    role: 'shared',
    action,
    exists: action !== 'install',
    ...(reason ? { reason } : {})
  }
}

export function agentLocation(
  name: string,
  action: BundledSkillLocationAction,
  reason?: BundledSkillLeaveReason,
  agentFolder = '.claude'
): BundledSkillLocationPlan {
  return {
    path: `/home/${agentFolder}/skills/${name}`,
    role: 'agent',
    action,
    exists: action !== 'link',
    ...(reason ? { reason } : {})
  }
}

export function skillPlan(
  name: string,
  locations: BundledSkillLocationPlan[],
  packageDigest = 'current'
): BundledSkillPlan {
  return { name, packageDigest, locations }
}

/** An Orca-installed shared copy one version behind, linked into Claude. */
export function updatablePlan(name: string): BundledSkillPlan {
  return skillPlan(name, [sharedLocation(name, 'update'), agentLocation(name, 'keep')])
}

export function currentPlan(name: string): BundledSkillPlan {
  return skillPlan(name, [sharedLocation(name, 'keep'), agentLocation(name, 'keep')])
}

export function blockedPlan(
  name: string,
  reason: BundledSkillLeaveReason = 'local-changes'
): BundledSkillPlan {
  return skillPlan(name, [sharedLocation(name, 'leave', reason)])
}

export function freshnessInventory(...skills: BundledSkillPlan[]): SkillFreshnessInventory {
  return { schemaVersion: 2, skills, scannedAt: 1 }
}
