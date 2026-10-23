import type {
  BundledSkillInstallResult,
  BundledSkillOp,
  BundledSkillPlan,
  BundledSkillPlanEntry
} from '../../../../shared/bundled-skill-plan'

const DIGEST = 'a'.repeat(64)

export function planOp(
  kind: BundledSkillOp['kind'],
  path: string,
  extra: Partial<BundledSkillOp> = {}
): BundledSkillOp {
  return {
    kind,
    path,
    role: path.includes('/.agents/') ? 'shared' : 'agent',
    agents: path.includes('/.claude/') ? ['claude'] : [],
    observed: { kind: 'absent' },
    cleanup: [],
    ...extra
  }
}

export function planEntry(name: string, ops: BundledSkillOp[]): BundledSkillPlanEntry {
  return { name, digest: DIGEST, ops }
}

/** One skill per name; each entry's shared op has the given kind. */
export function planOf(
  entries: readonly BundledSkillPlanEntry[],
  planDigest = 'b'.repeat(64)
): BundledSkillPlan {
  return { scope: 'global', homeDirectory: '/home/u', skills: entries, planDigest }
}

export function sharedEntry(
  name: string,
  kind: BundledSkillOp['kind'],
  extra: Partial<BundledSkillOp> = {}
): BundledSkillPlanEntry {
  return planEntry(name, [planOp(kind, `/home/u/.agents/skills/${name}`, extra)])
}

/** Every op of the plan ran as planned. */
export function doneResult(plan: BundledSkillPlan): BundledSkillInstallResult {
  return {
    scope: plan.scope,
    skills: plan.skills.map((entry) => ({
      name: entry.name,
      status: 'ran',
      ops: entry.ops.map((op) => ({
        path: op.path,
        kind: op.kind,
        status: 'done',
        ...(op.reason ? { reason: op.reason } : {})
      }))
    }))
  }
}
