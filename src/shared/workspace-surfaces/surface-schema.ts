import { surfaceExecutionProvenanceSchema } from './surface-execution-provenance'
import { z } from 'zod'
import type { TerminalPaneLayoutNode } from '../terminal-tab-types'
import { CreateTerminalTabCommand } from '../rpc-contract/workspace-layout-terminal-tab-params'
import { sleepingAgentSessionRecordSchema } from '../workspace-session-sleeping-agents'
import type { SurfaceContent, SurfaceLeaf, WorkspaceSurface } from './surface-content'
import { collectLayoutLeafIdsInOrder } from '../workspace-layout/terminal-pane-tree'
import { isTerminalLeafId } from '../stable-pane-id'

const id = z.string().min(1)
const leafId = id.refine(isTerminalLeafId)
const paneTree: z.ZodType<TerminalPaneLayoutNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('leaf'), leafId }),
    z.strictObject({
      type: z.literal('split'),
      direction: z.enum(['vertical', 'horizontal']),
      first: paneTree,
      second: paneTree
    })
  ])
)
const resume = z.unknown().transform((value, context) => {
  const parsed = sleepingAgentSessionRecordSchema.safeParse({
    ...(typeof value === 'object' && value !== null ? value : {}),
    // The containing surface and leaf derive these fields when projecting the legacy record.
    paneKey: 'surface',
    worktreeId: 'surface'
  })
  if (!parsed.success) {
    context.addIssue({ code: 'custom', message: 'surface resume record is unreadable' })
    return z.NEVER
  }
  const { paneKey: _paneKey, tabId: _tabId, worktreeId: _worktreeId, ...record } = parsed.data
  return record
})

export const surfaceLeafSchema: z.ZodType<SurfaceLeaf> = z.strictObject({
  occurrence: id,
  runId: id,
  executorId: id.optional(),
  provenance: surfaceExecutionProvenanceSchema.optional(),
  facts: z
    .strictObject({
      ptyId: id.optional(),
      incarnationId: id.optional(),
      sleeping: resume.optional(),
      resume: resume.optional()
    })
    .refine((facts) => !facts.incarnationId || facts.ptyId, {
      message: 'a process incarnation requires its terminal identity'
    })
})

export const surfaceContentSchema: z.ZodType<SurfaceContent> = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('terminal'),
      entityId: id,
      creation: CreateTerminalTabCommand.shape.creation.unwrap().extend({
        forceHostRuntime: z.boolean().optional()
      }),
      root: paneTree.nullable(),
      chatLeafId: id.optional(),
      leaves: z.record(leafId, surfaceLeafSchema)
    })
    .superRefine((content, context) => {
      const ids = collectLayoutLeafIdsInOrder(content.root)
      if (
        new Set(ids).size !== ids.length ||
        ids.length !== Object.keys(content.leaves).length ||
        ids.some((leafId) => !Object.hasOwn(content.leaves, leafId)) ||
        (content.chatLeafId !== undefined && !ids.includes(content.chatLeafId))
      ) {
        context.addIssue({ code: 'custom', message: 'terminal membership is inconsistent' })
      }
    }),
  z.strictObject({ kind: z.literal('agent-session'), sessionId: id, agent: id })
])

export const workspaceSurfaceSchema: z.ZodType<WorkspaceSurface> = z.strictObject({
  hostId: id,
  workspaceId: id,
  hostTabId: id,
  occurrence: id,
  revision: z.int().positive(),
  createdAt: z.int().nonnegative(),
  content: surfaceContentSchema.nullable()
})
