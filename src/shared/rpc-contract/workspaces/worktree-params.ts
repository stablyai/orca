import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  TriStateLinkedIssue
} from '../rpc-param-primitives'
import { WorkspaceLinkedItemSchema } from '../../workspace-attachments/workspace-linked-item-schema'
import { WorkspaceAttachmentsSchema } from '../../workspace-attachments/workspace-attachment-schema'
import {
  DiffCommentDeliverySnapshotSchema,
  DiffCommentSchema,
  MobileDiffReviewSchema
} from '../../file-review/diff-comment-schema'
import { TaskSourceContextSchema } from '../../work-items/task-source-context-schema'
import { CrossStoreParentRefSchema } from './cross-store-parent-params'
import {
  assertLinkedWorkItemSourceContextMatch,
  MatchFolderWorkspaces,
  OptionalExecutionHostId,
  WorktreeSelector
} from './worktree-query-params'

export * from './worktree-query-params'

export const WorktreeSet = lazyZodSchema(() =>
  WorktreeSelector.extend({
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
    // Explicit whole-workspace read intent; older hosts strip this field.
    acknowledgeAttention: z.boolean().optional(),
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
    // Why strict: a dropped note list would still answer ok, so the writer would think its notes saved.
    diffComments: z.array(DiffCommentSchema).optional(),
    // The list the writer started from; the host applies only its changes so other devices' notes survive.
    diffCommentsBase: z.array(DiffCommentSchema).optional(),
    deliveredDiffCommentSnapshots: z.array(DiffCommentDeliverySnapshotSchema).optional(),
    // Older clients may send unsupported review shapes alongside unrelated metadata edits.
    mobileDiffReview: MobileDiffReviewSchema.optional().catch(undefined),
    parentWorktree: OptionalString,
    matchFolderWorkspaces: MatchFolderWorkspaces,
    /** Sent only to hosts advertising worktree.lineage.crossMachine; older hosts strip it. */
    crossStoreParent: CrossStoreParentRefSchema.optional(),
    /** The cross-store parent is a bot's home, so cleanup on the child's host never groups it; older hosts strip it. */
    crossStoreParentIsBotHome: z.literal(true).optional(),
    noParent: OptionalBoolean,
    /** With a parent change: apply it only while the current parent is this workspace key (`folder:<id>`,
     *  `worktree:<id>`); refuses with lineage_parent_changed otherwise, so a newer move stands. */
    ifParentWorkspace: OptionalString
  }).superRefine((params, ctx) => {
    assertLinkedWorkItemSourceContextMatch(params, ctx)
    if ((params.parentWorktree || params.crossStoreParent) && params.noParent === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose either --parent-worktree or --no-parent, not both.'
      })
    }
    if (params.parentWorktree && params.crossStoreParent) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose one parent.' })
    }
  })
)

export const WorktreeRemove = lazyZodSchema(() =>
  WorktreeSelector.extend({
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
    waitForBackgroundRemoval: OptionalBoolean,
    // The reviewed nested-delete plan; the host re-lists and refuses if it no longer matches.
    approvedNestedWorktrees: z
      .array(z.object({ path: z.string().min(1), head: z.string(), branch: z.string() }))
      .min(1)
      .max(1_000)
      .optional(),
    // The caller showed that this also destroys the recipe environment Orca created for the workspace.
    // Absent: today's removal, which leaves that environment running. Older hosts strip it.
    destroyHost: z.literal(true).optional()
  })
)

/** Archive: delete the checkout, keep the branch and the workspace. Not exposed to users yet. */
export const WorktreeArchive = lazyZodSchema(() =>
  WorktreeSelector.extend({
    hostId: OptionalExecutionHostId
  })
)

/** Restore an archived workspace; `worktree` is its `id:` selector, since Git no longer lists it. */
export const WorktreeRestore = lazyZodSchema(() =>
  WorktreeSelector.extend({
    hostId: OptionalExecutionHostId,
    setupDecision: z.enum(['run', 'skip', 'inherit']).optional()
  })
)

export const WorktreePreviewNestedRemoval = lazyZodSchema(() =>
  WorktreeSelector.extend({
    hostId: OptionalExecutionHostId
  })
)

export const WorktreeForceDeleteBranch = lazyZodSchema(() =>
  WorktreeSelector.extend({
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
)

export const WorktreeResolvePrBase = lazyZodSchema(() =>
  z.object({
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
)

export const WorktreeResolveMrBase = lazyZodSchema(() =>
  z.object({
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
)
