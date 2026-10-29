import {
  isBundledSkillLeaveReason,
  isBundledSkillOpKind,
  type BundledSkillInstallResult,
  type BundledSkillLeaveReason,
  type BundledSkillOp,
  type BundledSkillOpKind,
  type BundledSkillOutcome,
  type BundledSkillPlan,
  type BundledSkillPlanEntry
} from './bundled-skill-plan'
import type { SkillInstallProviderId } from './skill-install-providers'
import { bundledSkillLocation, type BundledSkillLocation } from './bundled-skill-locations'

/** Ordered by precedence: a skill shows its highest state. */
export type BundledSkillPlanState = 'current' | 'attention' | 'install' | 'update' | 'repair'

const PLAN_STATE_ORDER: readonly BundledSkillPlanState[] = [
  'current',
  'attention',
  'install',
  'update',
  'repair'
]

// Record requires every new op kind to have a summary; unknown newer-server kinds become attention at runtime.
const OP_PLAN_STATE: Readonly<Record<BundledSkillOpKind, BundledSkillPlanState>> = {
  keep: 'current',
  leave: 'attention',
  write: 'install',
  link: 'install',
  copy: 'install',
  update: 'update',
  replace: 'update',
  restore: 'repair'
}

export const BUNDLED_SKILL_LEAVE_REASON_TEXT: Readonly<Record<BundledSkillLeaveReason, string>> = {
  edited: 'Skill edited outside Orca',
  other: 'A different skill uses this name',
  unwritable: "Orca can't write to this folder",
  unreadable: "Orca can't read every file",
  busy: 'Another install is still running',
  'shared-not-current': "The shared copy isn't Orca's"
}

/** What Update does at one location, for plain-text surfaces; the app translates its own. */
export const BUNDLED_SKILL_PLAN_OP_TEXT: Readonly<
  Record<Exclude<BundledSkillOpKind, 'leave'>, string>
> = {
  keep: 'No change',
  write: 'Install',
  copy: 'Install',
  update: 'Update',
  link: 'Link',
  replace: 'Replace',
  restore: 'Repair'
}

function opPlanState(op: Pick<BundledSkillOp, 'kind' | 'reason'>): BundledSkillPlanState {
  // Other owners’ same-named skills are listed without flagging them.
  if (op.kind === 'leave' && op.reason === 'other') {
    return 'current'
  }
  return isBundledSkillOpKind(op.kind) ? OP_PLAN_STATE[op.kind] : 'attention'
}

export function bundledSkillPlanState(entry: BundledSkillPlanEntry): BundledSkillPlanState {
  return entry.ops.reduce<BundledSkillPlanState>((highest, op) => {
    const state = opPlanState(op)
    return PLAN_STATE_ORDER.indexOf(state) > PLAN_STATE_ORDER.indexOf(highest) ? state : highest
  }, 'current')
}

export type BundledSkillPlanSummary = {
  /** Badge: only global-scope rewrites; link-only work is "Install for <agent>", never an update. */
  badge: 'update' | 'repair' | null
  hasWork: boolean
  skills: BundledSkillPlanSkillSummary[]
}

export type BundledSkillPlanSkillSummary = {
  name: string
  state: BundledSkillPlanState
  /** One per planned location, labelled by agent; the dialog's rows and location table. */
  locations: BundledSkillLocation[]
  upToDate: boolean
}

export function summarizeBundledSkillPlan(plan: BundledSkillPlan): BundledSkillPlanSummary {
  const skills = plan.skills.map((entry): BundledSkillPlanSkillSummary => {
    const state = bundledSkillPlanState(entry)
    return {
      name: entry.name,
      state,
      locations: entry.ops.map((op) => bundledSkillLocation(op, plan.homeDirectory)),
      upToDate: state === 'current' && entry.ops.every((op) => op.kind === 'keep')
    }
  })
  const states = new Set(skills.map((skill) => skill.state))
  const global = plan.scope === 'global'
  return {
    badge:
      global && states.has('repair') ? 'repair' : global && states.has('update') ? 'update' : null,
    // Clean leftover swap siblings or a stray released .orca-old could restore after the user deletes the skill.
    hasWork:
      skills.some((skill) => ['install', 'update', 'repair'].includes(skill.state)) ||
      plan.skills.some((entry) => entry.ops.some((op) => op.cleanup.length > 0)),
    skills
  }
}

/** A setup button runs useful work, offers Replace for replaceable copies, or shows attention for blocked locations. */
export type BundledSkillInstallAction =
  | { kind: 'run' }
  | { kind: 'replace'; paths: string[] }
  | { kind: 'attention' }
  | { kind: 'none' }

export function bundledSkillInstallAction(plan: BundledSkillPlan): BundledSkillInstallAction {
  if (summarizeBundledSkillPlan(plan).hasWork) {
    return { kind: 'run' }
  }
  const paths = plan.skills.flatMap((entry) =>
    entry.ops.flatMap((op) => (op.kind === 'leave' && op.replaceable ? [op.path] : []))
  )
  if (paths.length > 0) {
    return { kind: 'replace', paths }
  }
  const current =
    plan.skills.length > 0 &&
    plan.skills.every(
      (entry) => entry.ops.length > 0 && entry.ops.every((op) => op.kind === 'keep')
    )
  return { kind: current ? 'none' : 'attention' }
}

const INSTALLS_FOR_AGENT = new Set<string>(['write', 'link', 'copy'])

/** Agents a plan would newly give the skill: the "Install for <agent>" work. */
export function bundledSkillInstallAgents(
  entries: readonly BundledSkillPlanEntry[]
): SkillInstallProviderId[] {
  const agents = entries.flatMap((entry) =>
    entry.ops.flatMap((op) => (INSTALLS_FOR_AGENT.has(op.kind) ? op.agents : []))
  )
  return [...new Set(agents)].sort()
}

/** Changes whenever the skills the badge counts, or the bytes they would get, change. */
export function bundledSkillNudgeKey(hostId: string, plan: BundledSkillPlan): string | null {
  const counted = plan.skills
    .filter((entry) => ['update', 'repair'].includes(bundledSkillPlanState(entry)))
    .map((entry) => `${entry.name}@${entry.digest}`)
    .sort()
  return plan.scope === 'global' && counted.length > 0
    ? `bundled-skill:v1:${hostId}:${counted.join(',')}`
    : null
}

export type BundledSkillOutcomeText =
  | 'Updated'
  | 'Installed'
  | 'Linked'
  | 'No change'
  | 'Needs attention'

// Leaving another owner’s folder is reported without failure.
const DONE_TEXT: Readonly<Record<BundledSkillOpKind, BundledSkillOutcomeText | null>> = {
  keep: null,
  leave: null,
  write: 'Installed',
  copy: 'Installed',
  link: 'Linked',
  update: 'Updated',
  replace: 'Updated',
  // An interrupted update’s restored copy still needs updating.
  restore: 'Needs attention'
}
const OUTCOME_TEXT_ORDER: readonly BundledSkillOutcomeText[] = [
  'No change',
  'Linked',
  'Installed',
  'Updated',
  'Needs attention'
]

function hasProblem(outcome: BundledSkillOutcome): boolean {
  return outcome.status !== 'ran' || outcome.ops.some((op) => op.status !== 'done')
}

export function bundledSkillOutcomeText(outcome: BundledSkillOutcome): BundledSkillOutcomeText {
  if (hasProblem(outcome)) {
    return 'Needs attention'
  }
  return outcome.ops.reduce<BundledSkillOutcomeText>((highest, op) => {
    const text = isBundledSkillOpKind(op.kind)
      ? (DONE_TEXT[op.kind] ?? 'No change')
      : 'Needs attention'
    return OUTCOME_TEXT_ORDER.indexOf(text) > OUTCOME_TEXT_ORDER.indexOf(highest) ? text : highest
  }, 'No change')
}

export type BundledSkillLeftAlone = {
  path: string
  reason: string
  /** For translated surfaces; null for a reason this build does not know. */
  code: BundledSkillLeaveReason | null
}

export type BundledSkillOutcomeSummary = {
  name: string
  text: BundledSkillOutcomeText
  /** Printed as warnings; never part of the exit code. */
  leftAlone: BundledSkillLeftAlone[]
  /** e.g. "Updated - 1 skipped: Skill edited outside Orca". */
  line: string
}

function leaveReasonText(reason: string | undefined): string {
  return reason && isBundledSkillLeaveReason(reason)
    ? BUNDLED_SKILL_LEAVE_REASON_TEXT[reason]
    : 'This copy was kept as it is'
}

export function summarizeBundledSkillOutcome(
  outcome: BundledSkillOutcome
): BundledSkillOutcomeSummary {
  const text = bundledSkillOutcomeText(outcome)
  const leftAlone = outcome.ops
    .filter((op) => op.kind === 'leave')
    .map((op) => ({
      path: op.path,
      reason: leaveReasonText(op.reason),
      code: op.reason && isBundledSkillLeaveReason(op.reason) ? op.reason : null
    }))
  const reasons = [...new Set(leftAlone.map((left) => left.reason))].join('; ')
  return {
    name: outcome.name,
    text,
    leftAlone,
    line: leftAlone.length > 0 ? `${text} \u00B7 1 skipped: ${reasons}` : text
  }
}

export type BundledSkillResultSummary = {
  ok: boolean
  /** The CLI's exit code: 1 only when an op failed or found the disk changed. */
  exitCode: 0 | 1
  /** Skills the run changed: "Updated N skills · M skipped". */
  changedCount: number
  leftAloneCount: number
  skills: BundledSkillOutcomeSummary[]
}

export function summarizeBundledSkillOutcomes(
  result: BundledSkillInstallResult
): BundledSkillResultSummary {
  const ok = !result.skills.some(hasProblem)
  const skills = result.skills.map(summarizeBundledSkillOutcome)
  return {
    ok,
    exitCode: ok ? 0 : 1,
    changedCount: skills.filter((skill) => ['Updated', 'Installed', 'Linked'].includes(skill.text))
      .length,
    leftAloneCount: skills.filter((skill) => skill.leftAlone.length > 0).length,
    skills
  }
}
