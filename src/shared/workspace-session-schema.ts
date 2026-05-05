/* Why: the workspace session JSON is written to disk by older builds and read
 * back by newer ones. A field type flip (e.g. ptyId going from string to an
 * object) or a truncated write could poison Zustand state and crash the
 * renderer on mount. Schema-validating at the read boundary gives us a single
 * "reject and fall back to defaults" point so garbage never reaches React.
 *
 * Policy: be tolerant of extra fields (future builds may add more) but strict
 * about the types of fields we actually read. Unknown enum values, wrong types,
 * and wrong shapes all collapse to "use defaults" — never throw into main.
 */
import { z } from 'zod'
import type {
  BrowserWorkspace,
  TabGroupLayoutNode,
  TerminalPaneLayoutNode,
  WorkspaceSessionState
} from './types'

// ─── Terminal pane layout (recursive) ───────────────────────────────

const terminalPaneSplitDirectionSchema = z.enum(['vertical', 'horizontal'])

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

const terminalLayoutSnapshotSchema = z.object({
  root: terminalPaneLayoutNodeSchema.nullable(),
  activeLeafId: z.string().nullable(),
  expandedLeafId: z.string().nullable(),
  ptyIdsByLeafId: z.record(z.string(), z.string()).optional(),
  buffersByLeafId: z.record(z.string(), z.string()).optional(),
  titlesByLeafId: z.record(z.string(), z.string()).optional()
})

// ─── Terminal tab (legacy) ──────────────────────────────────────────

const terminalTabSchema = z.object({
  id: z.string(),
  ptyId: z.string().nullable(),
  worktreeId: z.string(),
  title: z.string(),
  defaultTitle: z.string().optional(),
  customTitle: z.string().nullable(),
  color: z.string().nullable(),
  sortOrder: z.number(),
  createdAt: z.number(),
  generation: z.number().optional()
})

// ─── Unified tab model ──────────────────────────────────────────────

const tabContentTypeSchema = z.enum(['terminal', 'editor', 'diff', 'conflict-review', 'browser'])

const workspaceVisibleTabTypeSchema = z.enum(['terminal', 'editor', 'browser'])

const tabSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  groupId: z.string(),
  worktreeId: z.string(),
  contentType: tabContentTypeSchema,
  label: z.string(),
  customLabel: z.string().nullable(),
  color: z.string().nullable(),
  sortOrder: z.number(),
  createdAt: z.number(),
  isPreview: z.boolean().optional(),
  isPinned: z.boolean().optional()
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
  isPreview: z.boolean().optional()
})

// ─── Browser ────────────────────────────────────────────────────────

const browserLoadErrorSchema = z.object({
  code: z.number(),
  description: z.string(),
  validatedUrl: z.string()
})

const browserViewportPresetIdSchema = z.enum([
  'mobile-s',
  'mobile-m',
  'mobile-l',
  'tablet',
  'laptop',
  'laptop-l',
  'desktop'
])

// Why: cast to WorkspaceSessionState's embedded BrowserWorkspace so future
// additive fields in the type flow through without requiring a schema edit.
const browserWorkspaceSchema: z.ZodType<BrowserWorkspace> = z.object({
  id: z.string(),
  worktreeId: z.string(),
  label: z.string().optional(),
  sessionProfileId: z.string().nullable().optional(),
  activePageId: z.string().nullable().optional(),
  pageIds: z.array(z.string()).optional(),
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  faviconUrl: z.string().nullable(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  loadError: browserLoadErrorSchema.nullable(),
  createdAt: z.number()
})

const browserPageSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  worktreeId: z.string(),
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  faviconUrl: z.string().nullable(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  loadError: browserLoadErrorSchema.nullable(),
  createdAt: z.number(),
  // Why: optional+nullable so sessions persisted before viewport presets were
  // added still validate; without this, zod would strip the field during
  // restore and reset the user's chosen preset on every app restart.
  viewportPresetId: browserViewportPresetIdSchema.nullable().optional()
})

const browserHistoryEntrySchema = z.object({
  url: z.string(),
  normalizedUrl: z.string(),
  title: z.string(),
  lastVisitedAt: z.number(),
  visitCount: z.number()
})

// ─── Workspace session ──────────────────────────────────────────────

export const workspaceSessionStateSchema: z.ZodType<WorkspaceSessionState> = z.object({
  activeRepoId: z.string().nullable(),
  activeWorktreeId: z.string().nullable(),
  activeTabId: z.string().nullable(),
  tabsByWorktree: z.record(z.string(), z.array(terminalTabSchema)),
  terminalLayoutsByTabId: z.record(z.string(), terminalLayoutSnapshotSchema),
  activeWorktreeIdsOnShutdown: z.array(z.string()).optional(),
  openFilesByWorktree: z.record(z.string(), z.array(persistedOpenFileSchema)).optional(),
  activeFileIdByWorktree: z.record(z.string(), z.string().nullable()).optional(),
  browserTabsByWorktree: z.record(z.string(), z.array(browserWorkspaceSchema)).optional(),
  browserPagesByWorkspace: z.record(z.string(), z.array(browserPageSchema)).optional(),
  activeBrowserTabIdByWorktree: z.record(z.string(), z.string().nullable()).optional(),
  activeTabTypeByWorktree: z.record(z.string(), workspaceVisibleTabTypeSchema).optional(),
  browserUrlHistory: z.array(browserHistoryEntrySchema).optional(),
  activeTabIdByWorktree: z.record(z.string(), z.string().nullable()).optional(),
  unifiedTabs: z.record(z.string(), z.array(tabSchema)).optional(),
  tabGroups: z.record(z.string(), z.array(tabGroupSchema)).optional(),
  tabGroupLayouts: z.record(z.string(), tabGroupLayoutNodeSchema).optional(),
  activeGroupIdByWorktree: z.record(z.string(), z.string()).optional(),
  activeConnectionIdsAtShutdown: z.array(z.string()).optional(),
  remoteSessionIdsByTabId: z.record(z.string(), z.string()).optional(),
  // Why: the sort comparator in order-empty-query-worktrees.ts would produce
  // NaN (undefined sort order) if a corrupted session file carried NaN or
  // Infinity here. Parse leniently: drop individual bad entries rather than
  // failing the entire session. A strict record() rejection here would cause
  // parseWorkspaceSession to fall back to defaults for the ENTIRE session
  // (terminals, editors, browsers, layouts) on a single corrupted timestamp
  // — a blast radius far larger than "Cmd+J falls back to activity recency",
  // which is all this field gates.
  lastVisitedAtByWorktreeId: z
    .preprocess(
      (raw) => {
        if (raw == null || typeof raw !== 'object') {
          return raw
        }
        const cleaned: Record<string, number> = {}
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
            cleaned[k] = v
          }
        }
        return cleaned
      },
      z.record(z.string(), z.number().finite().nonnegative())
    )
    .optional()
})

export type ParsedWorkspaceSession =
  | { ok: true; value: WorkspaceSessionState }
  | { ok: false; error: string }

/** Validate raw JSON as a WorkspaceSessionState. Returns a discriminated union
 *  so callers can fall back to defaults on failure without a try/catch. */
export function parseWorkspaceSession(raw: unknown): ParsedWorkspaceSession {
  const result = workspaceSessionStateSchema.safeParse(raw)
  if (result.success) {
    return { ok: true, value: result.data }
  }
  // Why: keep the error compact — a zod issue dump is noisy and most of the
  // time only the first divergent field is actionable for debugging.
  const firstIssue = result.error.issues[0]
  const path = firstIssue?.path.join('.') || '<root>'
  return { ok: false, error: `${path}: ${firstIssue?.message ?? 'invalid session'}` }
}
