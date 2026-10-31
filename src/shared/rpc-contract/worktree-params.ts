import { z } from 'zod'
import { normalizeExecutionHostId } from '../execution-host'
import { CLIENT_PROVENANCE_SNAPSHOT_MAX } from '../automation-workspace-provenance'
import { isTuiAgent } from '../tui-agent-config'
import type { TuiAgent } from '../tui-agent'
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  TriStateLinkedIssue
} from './rpc-param-primitives'
import { RUNTIME_NAVIGATION_TARGETS } from '../runtime-navigation'
import { WorkspaceLinkedItemSchema } from '../workspace-linked-item-schema'
import { WorkspaceAttachmentsSchema } from '../workspace-attachment-schema'
import { DiffCommentSchema, MobileDiffReviewSchema } from '../diff-comment-schema'
import { TaskSourceContextSchema } from '../task-source-context-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../workspace-linked-item-source-context'

export const OptionalExecutionHostId = z
  .string()
  .transform((value, ctx) => {
    const hostId = normalizeExecutionHostId(value)
    if (!hostId) {
      ctx.addIssue({ code: 'custom', message: 'Invalid host id' })
      return z.NEVER
    }
    return hostId
  })
  .optional()

export const OptionalTuiAgent = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value !== undefined && !isTuiAgent(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown TUI agent' })
    }
  })
  .transform((value): TuiAgent | undefined => (isTuiAgent(value) ? value : undefined))
  .optional()

export const AutomationWorkspaceProvenanceRequest = z.object({
  automationId: z.string(),
  automationRunId: z.string(),
  dispatchToken: z.string(),
  createRequestId: z.string()
})

// A label for another owner's run: the host records it only for automations it does not hold, and stamps createdAt.
const ProvenanceId = z.string().min(1).max(256)
const ProvenanceSnapshot = z.string().max(CLIENT_PROVENANCE_SNAPSHOT_MAX)
export const ClientAutomationWorkspaceProvenance = z.object({
  automationId: ProvenanceId,
  automationNameSnapshot: ProvenanceSnapshot,
  automationRunId: ProvenanceId,
  automationRunTitleSnapshot: ProvenanceSnapshot,
  executionTargetType: z.enum(['local', 'ssh']),
  executionTargetId: z.string().max(256),
  projectId: z.string().max(256),
  repoId: z.string().max(256).optional(),
  hostId: OptionalExecutionHostId
})

// Descriptive provenance grants no authority; the host stamps createdAt to avoid client-clock sort skew.
export const CliWorkspaceProvenanceRequest = z.object({
  callerTerminalHandle: OptionalString
})

export const WorktreeListParams = z.object({
  repo: OptionalString,
  limit: OptionalFiniteNumber
})

export const WorktreeDetectedListParams = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector'))
})

export const WorktreeTeardownMissingTerminalsParams = WorktreeDetectedListParams.extend({
  worktreeIds: z.array(z.string().min(1)).max(10_000),
  connectionId: z.string().nullable().optional()
})

export const WorktreePsParams = z.object({
  limit: OptionalFiniteNumber,
  afterSnapshotId: z.string().min(1).max(128).nullable().optional(),
  supportsWorktreeVisibilitySourceDefaults: z.literal(true).optional(),
  // Opt-in: wait lookups read screens and probe PTYs, too costly for pollers; older hosts omit agentWait.
  includeAgentWait: z.literal(true).optional()
})

export const WorktreeSortOrder = z.object({
  orderedIds: z.array(z.string()),
  // Parallel to orderedIds: the copy each id names, so a same-id twin keeps its own order.
  hostIds: z.array(z.string()).optional()
})

export const WorktreeSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

// Why optional: an older host strips the unknown field and marks its chats asleep as before.
export const WorktreeSleepParams = WorktreeSelector.extend({
  markChatsAsleep: z.boolean().optional()
})

export const WorktreeActivate = WorktreeSelector.extend({
  notifyClients: OptionalBoolean,
  navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional()
})

/** Shared by WorktreeCreate and WorktreeSet so the two error messages cannot drift. */
export function assertLinkedWorkItemSourceContextMatch(
  params: {
    linkedWorkItem?: z.infer<typeof WorkspaceLinkedItemSchema> | null
    linkedTaskSourceContext?: z.infer<typeof TaskSourceContextSchema> | null
  },
  ctx: z.RefinementCtx
): void {
  if (
    params.linkedWorkItem &&
    params.linkedTaskSourceContext &&
    !isWorkspaceLinkedItemSourceContextMatch(params.linkedWorkItem, params.linkedTaskSourceContext)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Linked work item and source context identities must match'
    })
  }
}

export const WorktreeSet = WorktreeSelector.extend({
  // Empty clears to branch/folder fallback; OptionalString would drop remote clears and restore the old name.
  displayName: OptionalPlainString,
  firstAgentMessageRenameError: z.null().optional(),
  // Preserve empty comment updates instead of coercing them to absent.
  comment: OptionalPlainString,
  linkedIssue: TriStateLinkedIssue,
  linkedPR: TriStateLinkedIssue,
  suppressedGitHubPR: z.number().int().positive().nullable().optional(),
  linkedLinearIssue: z.union([z.string(), z.null()]).optional(),
  linkedLinearIssueWorkspaceId: z.union([z.string(), z.null()]).optional(),
  linkedLinearIssueOrganizationUrlKey: z.union([z.string(), z.null()]).optional(),
  linkedGitLabMR: TriStateLinkedIssue,
  linkedGitLabIssue: TriStateLinkedIssue,
  linkedBitbucketPR: TriStateLinkedIssue,
  linkedAzureDevOpsPR: TriStateLinkedIssue,
  linkedGiteaPR: TriStateLinkedIssue,
  linkedWorkItem: WorkspaceLinkedItemSchema.nullable().optional(),
  linkedItems: WorkspaceAttachmentsSchema.optional(),
  linkedItemsBase: WorkspaceAttachmentsSchema.optional(),
  linkedItemsSelectionChanged: z.boolean().optional(),
  linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
  isArchived: OptionalBoolean,
  isUnread: OptionalBoolean,
  isPinned: OptionalBoolean,
  sortOrder: OptionalFiniteNumber,
  manualOrder: OptionalFiniteNumber,
  lastActivityAt: OptionalFiniteNumber,
  createdAt: OptionalFiniteNumber,
  sparseDirectories: z.array(z.string()).optional(),
  sparseBaseRef: OptionalString,
  sparsePresetId: OptionalString,
  baseRef: OptionalString,
  workspaceStatus: OptionalString,
  pushTarget: z
    .object({
      remoteName: z.string(),
      branchName: z.string(),
      remoteUrl: OptionalString
    })
    .nullable()
    .optional(),
  // Older clients may send unsupported review shapes alongside unrelated metadata edits.
  diffComments: z.array(DiffCommentSchema).optional().catch(undefined),
  // The list the writer started from; the host applies only its changes so other devices' notes survive.
  diffCommentsBase: z.array(DiffCommentSchema).optional().catch(undefined),
  mobileDiffReview: MobileDiffReviewSchema.optional().catch(undefined),
  parentWorktree: OptionalString,
  noParent: OptionalBoolean
}).superRefine((params, ctx) => {
  assertLinkedWorkItemSourceContextMatch(params, ctx)
  if (params.parentWorktree && params.noParent === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Choose either --parent-worktree or --no-parent, not both.'
    })
  }
})

export const WorktreeRemove = WorktreeSelector.extend({
  // Omission retains legacy/UI metadata policy; explicit CLI intent overrides it.
  deleteBranch: OptionalBoolean,
  hostId: OptionalExecutionHostId,
  force: OptionalBoolean,
  // Desktop force also means ordinary confirmed delete; PTY-stop waivers need their own field (#11960).
  allowUnverifiedPtyStop: OptionalBoolean,
  runHooks: OptionalBoolean,
  // Waive failed-hook refusal explicitly and record it; independent of force and whether hooks run (#19334).
  allowFailedArchiveHook: OptionalBoolean,
  // Reply with Git's outcome instead of on acceptance; older hosts strip it and answer `removing: true` (#35135).
  waitForBackgroundRemoval: OptionalBoolean
})

export const WorktreeForceDeleteBranch = WorktreeSelector.extend({
  hostId: OptionalExecutionHostId,
  branchName: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing branch name')),
  expectedHead: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing expected branch head'))
})

export const WorktreeResolvePrBase = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector')),
  prNumber: z
    .unknown()
    .transform((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
    .pipe(z.number().int().positive('Missing PR number')),
  headRefName: OptionalString,
  baseRefName: OptionalString,
  isCrossRepository: OptionalBoolean,
  /** The user creating or launching from the PR; older hosts drop it. */
  wakeWslDistro: OptionalBoolean
})

export const WorktreeResolveMrBase = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector')),
  mrIid: z
    .unknown()
    .transform((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
    .pipe(z.number().int().positive('Missing MR number')),
  sourceBranch: OptionalString,
  targetBranch: OptionalString,
  isCrossRepository: OptionalBoolean,
  /** The user creating from the MR; older hosts drop it. */
  wakeWslDistro: OptionalBoolean
})
