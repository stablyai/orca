import { z } from 'zod'
import type {
  LayoutCommand,
  LayoutCommandResult,
  LayoutContext
} from '../workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../workspace-layout/workspace-layout-model'
import type { SurfaceContent, SurfaceExpectation, SurfaceKey } from './surface-content'
import { workspaceSurfaceSchema } from './surface-schema'

export type SurfaceCommandIdentity = {
  hostId: string
  callerId: string
  commandId: string
  expiresAt: number
}
export type SurfaceTarget = {
  workspaceId?: string
  hostTabId: string
  expected: SurfaceExpectation | null
  leaf?: { leafId: string; occurrence: string; runId?: string }
}
export type SurfaceLayoutRequest = SurfaceCommandIdentity & {
  command: LayoutCommand
  targets: readonly SurfaceTarget[]
}
export type SurfaceLayoutView = {
  model: WorkspaceLayoutModel
  context: LayoutContext
  chatVerified?: boolean
}

const id = z.string().min(1)
export const surfaceCommandRefusalSchema = z.enum([
  'workspace_not_found',
  'tab_not_found',
  'pane_not_found',
  'group_not_found',
  'invalid_params',
  'group_set_changed',
  'pane_structure_changed',
  'same_pane',
  'last_pane',
  'pane_sleeping',
  'pane_already_bound',
  'workspace_exists',
  'tab_exists',
  'tab_closed',
  'group_exists',
  'pane_in_other_tab',
  'pty_mismatch',
  'page_exists',
  'generated_title_kept',
  'host_not_owned',
  'other_partition',
  'wsl_move_in_progress'
])
const result = z.object({
  tabId: id.optional(),
  leafId: id.optional(),
  paneKey: id.optional(),
  groupId: id.optional(),
  pageId: id.optional(),
  ptyId: id.nullable().optional(),
  tabClosed: z.boolean().optional(),
  alreadyClosed: z.boolean().optional(),
  closed: z.array(id).optional(),
  refused: z
    .array(z.object({ tabId: id, code: z.enum(['tab_pinned', 'editor_tab_has_unsaved_draft']) }))
    .optional(),
  slept: z.array(id).optional(),
  woken: z.array(id).optional(),
  renamedTabIds: z.record(id, id).optional(),
  untitled: z
    .array(z.object({ workspace: id, tabId: id, code: surfaceCommandRefusalSchema }))
    .optional(),
  createdTabs: z.array(z.object({ tabId: id, leafId: id, paneKey: id })).optional()
}) satisfies z.ZodType<LayoutCommandResult>

export const surfaceCommandOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('accepted'),
    revision: z.int().nonnegative(),
    surfaces: z.array(workspaceSurfaceSchema),
    result,
    effects: z.strictObject({ stopPtyIds: z.array(id), startPaneKeys: z.array(id) })
  }),
  z.strictObject({
    status: z.literal('conflict'),
    code: id,
    current: workspaceSurfaceSchema.nullable()
  })
])
export type SurfaceCommandOutcome = z.infer<typeof surfaceCommandOutcomeSchema>
export type SurfaceContentReplacement = SurfaceCommandIdentity &
  SurfaceKey & {
    expected: SurfaceExpectation | null
    content: SurfaceContent | null
  }

export type SurfaceMoveRequest = SurfaceCommandIdentity &
  SurfaceKey & {
    expected: SurfaceExpectation
    destination: { workspaceId: string; hostTabId: string; expected: SurfaceExpectation | null }
  }
