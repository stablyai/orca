import { z } from 'zod'
import type { SkillInstallProviderId } from './skill-install-providers'

// Frozen per capability version: a client renders a value it does not know as "Needs attention".
export const BUNDLED_SKILL_OP_KINDS = Object.freeze([
  'keep',
  'write',
  'update',
  'link',
  'copy',
  'restore',
  'leave',
  'replace'
] as const)
export type BundledSkillOpKind = (typeof BUNDLED_SKILL_OP_KINDS)[number]

export function isBundledSkillOpKind(value: string): value is BundledSkillOpKind {
  return BUNDLED_SKILL_OP_KINDS.some((kind) => kind === value)
}

export const BUNDLED_SKILL_LEAVE_REASONS = Object.freeze([
  'edited',
  'other',
  'unwritable',
  'unreadable',
  'busy',
  'shared-not-current'
] as const)
export type BundledSkillLeaveReason = (typeof BUNDLED_SKILL_LEAVE_REASONS)[number]

export function isBundledSkillLeaveReason(value: string): value is BundledSkillLeaveReason {
  return BUNDLED_SKILL_LEAVE_REASONS.some((reason) => reason === value)
}

export const BUNDLED_SKILL_OP_STATUSES = Object.freeze([
  'done',
  'changed',
  'skipped',
  'failed'
] as const)
export type BundledSkillOpStatus = (typeof BUNDLED_SKILL_OP_STATUSES)[number]

/** What a path held when planned; execute refuses to act once it differs. */
export type BundledSkillObserved =
  | { kind: 'absent' }
  | { kind: 'link'; target: string }
  /** `entries` lists every non-OS-metadata name as `name:kind`; `skillDigest` is LF sha256. */
  | {
      kind: 'folder'
      entries: readonly string[]
      skillDigest: string | null
      /** Whole-tree identity for edited/foreign content; released copies omit it. */
      treeDigest?: string
    }
  /** Includes sockets and devices. */
  | { kind: 'file'; mtimeMs: number | null; treeDigest?: string }
  | { kind: 'unreadable' }

/** A leftover sibling of an interrupted Orca swap, handled before the target's op. */
export type BundledSkillCleanup = {
  path: string
  /** `delete` only ever applies to Orca's stage siblings and released old copies. */
  action: 'delete' | 'backup'
  observed: BundledSkillObserved
}

export type BundledSkillOp = {
  kind: BundledSkillOpKind
  path: string
  role: 'shared' | 'agent'
  agents: readonly SkillInstallProviderId[]
  observed: BundledSkillObserved
  /** What `write`/`update`/`copy`/`replace`/`link` put at `path`. */
  content?: 'files' | 'link'
  linkTarget?: string
  /** The interrupted swap's old copy a `restore` moves back. */
  restoreFrom?: { path: string; observed: BundledSkillObserved }
  reason?: BundledSkillLeaveReason
  /** Whether Replace / `--force` may back this up and put Orca's copy in its place. */
  replaceable?: boolean
  /** Path of an earlier op that must succeed first. */
  requires?: string
  cleanup: readonly BundledSkillCleanup[]
}

export type BundledSkillPlanEntry = {
  name: string
  /** LF sha256 of the `SKILL.md` this build writes. */
  digest: string
  /** Shared-root op first, then agent roots. */
  ops: readonly BundledSkillOp[]
}

export type BundledSkillPlan = {
  scope: 'global' | 'workspace'
  /** The planned host's home, so surfaces can show `~` paths; not part of the digest. */
  homeDirectory: string
  skills: readonly BundledSkillPlanEntry[]
  /** Canonical digest of `skills`; execute applies only a plan that still hashes to it. */
  planDigest: string
}

export type BundledSkillOpOutcome = {
  path: string
  kind: BundledSkillOpKind
  status: BundledSkillOpStatus
  reason?: BundledSkillLeaveReason
  error?: string
  /** Where Replace or a non-released old copy was moved. */
  backupPath?: string
}

export type BundledSkillOutcome = {
  name: string
  /** `changed`: the disk no longer matches the plan, so nothing ran; `busy`: a lock was held. */
  status: 'ran' | 'changed' | 'busy'
  ops: readonly BundledSkillOpOutcome[]
}

export type BundledSkillInstallResult = {
  scope: 'global' | 'workspace'
  skills: readonly BundledSkillOutcome[]
}

const BundledSkillForceSchema = z.array(z.string().min(1).max(4096)).max(256)

/** Frozen strict skills.bundled-orca.v1 request for the host’s own global homes; adding fields requires a new capability because older hosts reject them. */
export const BundledSkillPlanRequestSchema = z.strictObject({
  force: BundledSkillForceSchema.optional(),
  /** Install named host-shipped skills; absent means update installed skills only. Reject names the host does not ship. */
  names: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u))
    .min(1)
    .max(64)
    .optional()
})
export type BundledSkillPlanRequest = z.infer<typeof BundledSkillPlanRequestSchema>

const PlanDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u)

/** Runs the plan `request` produced, identified by its digest; the ops are never re-sent. */
export const BundledSkillExecuteRequestSchema = z.strictObject({
  planDigest: PlanDigestSchema,
  request: BundledSkillPlanRequestSchema
})
export type BundledSkillExecuteRequest = z.infer<typeof BundledSkillExecuteRequestSchema>
