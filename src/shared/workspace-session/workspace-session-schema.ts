// Validate persisted sessions at read boundaries so malformed legacy data never reaches React. Ignore unknown fields, validate fields we read, and salvage independent entries via zod-salvage; only non-session payloads reset to defaults.
import { z } from 'zod'
import {
  leafStringsSchema,
  terminalLayoutSnapshotSchema
} from '../workspace-layout/terminal-topology/terminal-layout-snapshot-schema'
import { closedTerminalPaneSchema } from '../workspace-layout/terminal-surfaces/closed-terminal-panes'
import { closedTerminalTabTombstoneSchema } from '../workspace-layout/terminal-surfaces/closed-terminal-tab-tombstones'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { terminalTabIdSchema } from '../workspace-layout/terminal-surfaces/terminal-tab-id-schema'
import { terminalSurfaceTombstoneSchema } from '../workspace-layout/terminal-surfaces/terminal-surface-tombstone-schema'
import { type WorkspaceKey, isWorkspaceKey } from '../workspace/identity/workspace-scope'
import {
  browserHistoryEntriesSchema,
  workspaceDocHistoryEntriesSchema,
  browserPageSchema,
  browserWorkspaceSchema
} from './workspace-session-browser-schema'
import { workspaceSessionCloseIntentFieldSchemas } from './workspace-session-close-intent-schema'
import { persistedClientHostedBrowserPageSchema } from './client-hosted-browser-page-record'
import { persistedOpenFileSchema } from './workspace-session-editor-schema'
import { sleepingAgentSessionsByPaneKeySchema } from './workspace-session-sleeping-agents'
import { workspaceVisibleTabTypeSchema } from './workspace-session-tab-type-schema'
import {
  salvagedField,
  salvagedOptional,
  salvagingArray,
  salvagingRecord
} from '../validation/zod-salvage'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import {
  executionHostIdSchema,
  tabGroupLayoutNodeSchema,
  tabGroupSchema,
  tabSchema,
  terminalTabSchema
} from './workspace-session-tab-schemas'

export { terminalTabSchema } from './workspace-session-tab-schemas'

const workspaceKeySchema = lazyZodSchema(() =>
  z.custom<WorkspaceKey>((value) => typeof value === 'string' && isWorkspaceKey(value))
)

const worktreeIdSchema = lazyZodSchema(() => z.string())

export const workspaceSessionStateSchema: z.ZodType<WorkspaceSessionState> = lazyZodSchema(() =>
  z.object({
    activeRepoId: salvagedField('activeRepoId', z.string().nullable(), () => null),
    activeWorkspaceKey: salvagedOptional('activeWorkspaceKey', workspaceKeySchema.nullable()),
    activeWorkspaceExecutionHostId: salvagedOptional(
      'activeWorkspaceExecutionHostId',
      executionHostIdSchema.nullable()
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
    // Client-local park scrollback stays outside layout snapshots so remote projection cannot upload it; older profiles may omit it.
    localOnlyScrollbackByTabId: salvagedOptional(
      'localOnlyScrollbackByTabId',
      salvagingRecord(terminalTabIdSchema, leafStringsSchema)
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
    clientHostedBrowserPagesByWorktree: salvagedOptional(
      'clientHostedBrowserPagesByWorktree',
      salvagingRecord(worktreeIdSchema, salvagingArray(persistedClientHostedBrowserPageSchema))
    ),
    ...workspaceSessionCloseIntentFieldSchemas,
    activeTabTypeByWorktree: salvagedOptional(
      'activeTabTypeByWorktree',
      salvagingRecord(worktreeIdSchema, workspaceVisibleTabTypeSchema)
    ),
    browserUrlHistory: salvagedOptional('browserUrlHistory', browserHistoryEntriesSchema),
    workspaceDocHistory: salvagedOptional('workspaceDocHistory', workspaceDocHistoryEntriesSchema),
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
    desktopRelayOwnerByTabId: salvagedOptional(
      'desktopRelayOwnerByTabId',
      salvagingRecord(terminalTabIdSchema, z.string())
    ),
    desktopRelayAdoptionVersion: salvagedOptional(
      'desktopRelayAdoptionVersion',
      z.number().int().nonnegative()
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
    ),
    closedTerminalTabTombstonesByTabId: salvagedOptional(
      'closedTerminalTabTombstonesByTabId',
      salvagingRecord(terminalTabIdSchema, closedTerminalTabTombstoneSchema)
    ),
    closedTerminalPanesByPaneKey: salvagedOptional(
      'closedTerminalPanesByPaneKey',
      salvagingRecord(z.string().min(1), closedTerminalPaneSchema)
    )
  })
)

export type ParsedWorkspaceSession =
  | { ok: true; value: WorkspaceSessionState }
  | { ok: false; error: string }

/** Report only the first divergent field to keep repair diagnostics actionable. */
export function describeWorkspaceSessionError(error: z.ZodError): string {
  const firstIssue = error.issues[0]
  const path = firstIssue?.path.join('.') || '<root>'
  return `${path}: ${firstIssue?.message ?? 'invalid session'}`
}

export const WORKSPACE_SESSION_UNVALIDATABLE = '<root>: session could not be validated'

/** Return null if validation itself throws: materializing hundreds of thousands of Zod issues can overflow during Store construction and otherwise prevent launch. */
export function safeParseWorkspaceSession(
  raw: unknown
): ReturnType<typeof workspaceSessionStateSchema.safeParse> | null {
  try {
    return workspaceSessionStateSchema.safeParse(raw)
  } catch {
    return null
  }
}

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
