/* Why: the workspace session JSON is written to disk by older builds and read
 * back by newer ones. A field type flip (e.g. ptyId going from string to an
 * object) or a truncated write could poison Zustand state and crash the
 * renderer on mount. Schema-validating at the read boundary gives us a single
 * "reject and fall back to defaults" point so garbage never reaches React.
 *
 * Policy: be tolerant of extra fields (future builds may add more) but strict
 * about the types of fields we actually read. Where a field holds a collection
 * of independent records, tolerance is declared on the field itself (see
 * ./zod-salvage): a corrupt entry is dropped and the rest of the session
 * survives, because one bad tab record must not cost every worktree its state.
 * Only a payload that is not a session at all falls back to defaults.
 */
import { z } from 'zod'
import type {
  TabGroupLayoutNode,
  TerminalPaneLayoutNode,
  TuiAgent,
  WorkspaceKey,
  WorkspaceSessionState
} from './types'
import { isValidTerminalTabId } from './terminal-tab-id'
import { parseExecutionHostId, type ExecutionHostId } from './execution-host'
import { isTuiAgent } from './tui-agent-config'
import { isWorkspaceKey } from './workspace-scope'
import {
  browserHistoryEntriesSchema,
  browserPageSchema,
  browserWorkspaceSchema
} from './workspace-session-browser-schema'
import { sleepingAgentSessionsByPaneKeySchema } from './workspace-session-sleeping-agents'
import { salvagedField, salvagedOptional, salvagingArray, salvagingRecord } from './zod-salvage'

// ─── Terminal pane layout (recursive) ───────────────────────────────

const terminalPaneSplitDirectionSchema = z.enum(['vertical', 'horizontal'])
const terminalTabIdSchema = z
  .string()
  .min(1)
  .refine(isValidTerminalTabId, 'terminal tab id must not contain ":"')
const workspaceKeySchema = z.custom<WorkspaceKey>(
  (value) => typeof value === 'string' && isWorkspaceKey(value)
)

// Why: z.lazy + type annotation keeps the recursive inference working without
// forcing zod to resolve the whole tree at definition time.
const terminalPaneLayoutNodeSchema: z.ZodType<TerminalPaneLayoutNode> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal('leaf'),
      leafId: z.string()
    }),
    z.object({
      type: z.literal('split'),
      direction: terminalPaneSplitDirectionSchema,
      first: terminalPaneLayoutNodeSchema,
      second: terminalPaneLayoutNodeSchema,
      ratio: z.number().optional()
    })
  ])
)

const leafStringsSchema = salvagingRecord(z.string(), z.string())

const terminalLayoutSnapshotSchema = z.object({
  root: terminalPaneLayoutNodeSchema.nullable(),
  activeLeafId: z.string().nullable(),
  expandedLeafId: z.string().nullable(),
  ptyIdsByLeafId: salvagedOptional('ptyIdsByLeafId', leafStringsSchema),
  buffersByLeafId: salvagedOptional('buffersByLeafId', leafStringsSchema),
  scrollbackRefsByLeafId: salvagedOptional('scrollbackRefsByLeafId', leafStringsSchema),
  titlesByLeafId: salvagedOptional('titlesByLeafId', leafStringsSchema)
})

// ─── Terminal tab (legacy) ──────────────────────────────────────────

const terminalTabSchema = z.object({
  id: terminalTabIdSchema,
  ptyId: z.string().nullable(),
  worktreeId: z.string(),
  title: z.string(),
  defaultTitle: z.string().optional(),
  generatedTitle: z.string().nullable().optional(),
  aiVaultTitle: z
    .object({
      agent: z.enum(['claude', 'codex']),
      sessionId: z.string(),
      title: z.string()
    })
    .nullable()
    .optional()
    .catch(undefined),
  quickCommandLabel: z.string().nullable().optional(),
  customTitle: z.string().nullable(),
  color: z.string().nullable(),
  isPinned: z.boolean().optional(),
  sortOrder: z.number(),
  createdAt: z.number(),
  generation: z.number().optional(),
  startupCwd: z.string().min(1).optional(),
  // Why: persist the launched agent so a restored idle agent tab keeps its
  // provider icon before any hook fires. `.catch(undefined)` keeps a stale or
  // unknown agent id from failing the whole-session parse (which would reset
  // every terminal/editor/browser to defaults).
  launchAgent: z
    .custom<TuiAgent>((v) => isTuiAgent(v))
    .optional()
    .catch(undefined)
})

// ─── Unified tab model ──────────────────────────────────────────────

const tabContentTypeSchema = z.enum([
  'terminal',
  'editor',
  'diff',
  'conflict-review',
  'check-details',
  'browser',
  'simulator'
])

const workspaceVisibleTabTypeSchema = z.enum(['terminal', 'editor', 'browser', 'simulator'])

const tabSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  groupId: z.string(),
  worktreeId: z.string(),
  contentType: tabContentTypeSchema,
  label: z.string(),
  generatedLabel: z.string().nullable().optional(),
  aiVaultTitle: z
    .object({
      agent: z.enum(['claude', 'codex']),
      sessionId: z.string(),
      title: z.string()
    })
    .nullable()
    .optional()
    .catch(undefined),
  quickCommandLabel: z.string().nullable().optional(),
  customLabel: z.string().nullable(),
  color: z.string().nullable(),
  sortOrder: z.number(),
  createdAt: z.number(),
  isPreview: z.boolean().optional(),
  isPinned: z.boolean().optional(),
  // Why: persist the per-tab native-chat view mode so 'chat' survives reload /
  // session restore. `.catch('terminal')` tolerates unknown future values (a
  // newer build that wrote an unrecognized mode) by degrading to the safe
  // default instead of failing the whole-session parse. Legacy/missing stays
  // undefined → 'terminal' in the renderer.
  viewMode: z.enum(['terminal', 'chat']).catch('terminal').optional()
})

const tabGroupSchema = z.object({
  id: z.string(),
  worktreeId: z.string(),
  activeTabId: z.string().nullable(),
  tabOrder: z.array(z.string()),
  recentTabIds: z.array(z.string()).optional()
})

const tabGroupSplitDirectionSchema = z.enum(['horizontal', 'vertical'])

const tabGroupLayoutNodeSchema: z.ZodType<TabGroupLayoutNode> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal('leaf'),
      groupId: z.string()
    }),
    z.object({
      type: z.literal('split'),
      direction: tabGroupSplitDirectionSchema,
      first: tabGroupLayoutNodeSchema,
      second: tabGroupLayoutNodeSchema,
      ratio: z.number().optional()
    })
  ])
)

// ─── Editor ─────────────────────────────────────────────────────────

const persistedOpenFileSchema = z.object({
  filePath: z.string(),
  relativePath: z.string(),
  worktreeId: z.string(),
  language: z.string(),
  isPreview: z.boolean().optional(),
  runtimeEnvironmentId: z.string().nullable().optional(),
  externalSshTargetId: z.string().trim().min(1).optional(),
  dirtyDraftContent: z.string().optional(),
  lastKnownDiskSignature: z.string().optional(),
  readOnly: z.boolean().optional(),
  liveTail: z.boolean().optional()
})

// ─── Workspace session ──────────────────────────────────────────────

const terminalSurfaceTombstoneSchema = z.object({
  worktreeId: z.string(),
  parentTabId: terminalTabIdSchema,
  leafId: z.string(),
  ptyId: z.string(),
  incarnationId: z.string().min(1).max(128),
  retiredAt: z.number().finite().nonnegative()
})

const worktreeIdSchema = z.string()

export const workspaceSessionStateSchema: z.ZodType<WorkspaceSessionState> = z.object({
  activeRepoId: salvagedField('activeRepoId', z.string().nullable(), () => null),
  activeWorkspaceKey: salvagedOptional('activeWorkspaceKey', workspaceKeySchema.nullable()),
  activeWorkspaceExecutionHostId: salvagedOptional(
    'activeWorkspaceExecutionHostId',
    z
      .custom<ExecutionHostId>(
        (value) => typeof value === 'string' && Boolean(parseExecutionHostId(value))
      )
      .nullable()
  ),
  activeWorktreeId: salvagedField('activeWorktreeId', z.string().nullable(), () => null),
  activeTabId: salvagedField('activeTabId', z.string().nullable(), () => null),
  tabsByWorktree: salvagedField(
    'tabsByWorktree',
    salvagingRecord(worktreeIdSchema, salvagingArray(terminalTabSchema)),
    () => ({})
  ),
  terminalLayoutsByTabId: salvagedField(
    'terminalLayoutsByTabId',
    salvagingRecord(terminalTabIdSchema, terminalLayoutSnapshotSchema),
    () => ({})
  ),
  activeWorktreeIdsOnShutdown: salvagedOptional(
    'activeWorktreeIdsOnShutdown',
    salvagingArray(worktreeIdSchema)
  ),
  openFilesByWorktree: salvagedOptional(
    'openFilesByWorktree',
    salvagingRecord(worktreeIdSchema, salvagingArray(persistedOpenFileSchema))
  ),
  activeFileIdByWorktree: salvagedOptional(
    'activeFileIdByWorktree',
    salvagingRecord(worktreeIdSchema, z.string().nullable())
  ),
  markdownFrontmatterVisible: salvagedOptional(
    'markdownFrontmatterVisible',
    salvagingRecord(z.string(), z.boolean())
  ),
  browserTabsByWorktree: salvagedOptional(
    'browserTabsByWorktree',
    salvagingRecord(worktreeIdSchema, salvagingArray(browserWorkspaceSchema))
  ),
  browserPagesByWorkspace: salvagedOptional(
    'browserPagesByWorkspace',
    salvagingRecord(z.string(), salvagingArray(browserPageSchema))
  ),
  activeBrowserTabIdByWorktree: salvagedOptional(
    'activeBrowserTabIdByWorktree',
    salvagingRecord(worktreeIdSchema, z.string().nullable())
  ),
  activeTabTypeByWorktree: salvagedOptional(
    'activeTabTypeByWorktree',
    salvagingRecord(worktreeIdSchema, workspaceVisibleTabTypeSchema)
  ),
  browserUrlHistory: salvagedOptional('browserUrlHistory', browserHistoryEntriesSchema),
  activeTabIdByWorktree: salvagedOptional(
    'activeTabIdByWorktree',
    salvagingRecord(worktreeIdSchema, z.string().nullable())
  ),
  unifiedTabs: salvagedOptional(
    'unifiedTabs',
    salvagingRecord(worktreeIdSchema, salvagingArray(tabSchema))
  ),
  tabGroups: salvagedOptional(
    'tabGroups',
    salvagingRecord(worktreeIdSchema, salvagingArray(tabGroupSchema))
  ),
  tabGroupLayouts: salvagedOptional(
    'tabGroupLayouts',
    salvagingRecord(worktreeIdSchema, tabGroupLayoutNodeSchema)
  ),
  activeGroupIdByWorktree: salvagedOptional(
    'activeGroupIdByWorktree',
    salvagingRecord(worktreeIdSchema, z.string())
  ),
  activeConnectionIdsAtShutdown: salvagedOptional(
    'activeConnectionIdsAtShutdown',
    salvagingArray(z.string())
  ),
  remoteSessionIdsByTabId: salvagedOptional(
    'remoteSessionIdsByTabId',
    salvagingRecord(terminalTabIdSchema, z.string())
  ),
  // Why: the sort comparator in order-empty-query-worktrees.ts would produce NaN
  // (undefined sort order) from a NaN or Infinity persisted here.
  lastVisitedAtByWorktreeId: salvagedOptional(
    'lastVisitedAtByWorktreeId',
    salvagingRecord(worktreeIdSchema, z.number().finite().nonnegative())
  ),
  defaultTerminalTabsAppliedByWorktreeId: salvagedOptional(
    'defaultTerminalTabsAppliedByWorktreeId',
    salvagingRecord(worktreeIdSchema, z.literal(true))
  ),
  sleepingAgentSessionsByPaneKey: salvagedOptional(
    'sleepingAgentSessionsByPaneKey',
    sleepingAgentSessionsByPaneKeySchema
  ),
  terminalPtyIncarnationsByPaneKey: salvagedOptional(
    'terminalPtyIncarnationsByPaneKey',
    salvagingRecord(z.string(), z.string().min(1).max(128))
  ),
  terminalTopologyRevisionByRepoId: salvagedOptional(
    'terminalTopologyRevisionByRepoId',
    salvagingRecord(z.string(), z.number().int().nonnegative())
  ),
  terminalSurfaceTombstonesByPaneKey: salvagedOptional(
    'terminalSurfaceTombstonesByPaneKey',
    salvagingRecord(z.string(), terminalSurfaceTombstoneSchema)
  )
})

export type ParsedWorkspaceSession =
  | { ok: true; value: WorkspaceSessionState }
  | { ok: false; error: string }

/** Why: keep the error compact — a zod issue dump is noisy and most of the time
 *  only the first divergent field is actionable for debugging. */
export function describeWorkspaceSessionError(error: z.ZodError): string {
  const firstIssue = error.issues[0]
  const path = firstIssue?.path.join('.') || '<root>'
  return `${path}: ${firstIssue?.message ?? 'invalid session'}`
}

export const WORKSPACE_SESSION_UNVALIDATABLE = '<root>: session could not be validated'

/** safeParse, or null when the validator itself could not run.
 *  Why: safeParse is documented not to throw, but a payload holding hundreds of
 *  thousands of bad records overflows the stack while zod materializes an issue
 *  per field. This parse runs in the Store constructor, so an escaping RangeError
 *  is a launch failure the user cannot recover from without deleting their
 *  profile — exactly the "never throw into main" contract at the top of this file. */
export function safeParseWorkspaceSession(
  raw: unknown
): ReturnType<typeof workspaceSessionStateSchema.safeParse> | null {
  try {
    return workspaceSessionStateSchema.safeParse(raw)
  } catch {
    return null
  }
}

/** Validate raw JSON as a WorkspaceSessionState. Returns a discriminated union
 *  so callers can fall back to defaults on failure without a try/catch. */
export function parseWorkspaceSession(raw: unknown): ParsedWorkspaceSession {
  const result = safeParseWorkspaceSession(raw)
  if (!result) {
    return { ok: false, error: WORKSPACE_SESSION_UNVALIDATABLE }
  }
  if (result.success) {
    return { ok: true, value: result.data }
  }
  return { ok: false, error: describeWorkspaceSessionError(result.error) }
}
