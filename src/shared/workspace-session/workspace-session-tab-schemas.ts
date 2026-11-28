import { z } from 'zod'
import type { TabGroupLayoutNode } from '../workspace-layout/tab-groups/tab-types'
import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import { terminalTabIdSchema } from '../workspace-layout/terminal-surfaces/terminal-tab-id-schema'
import { parseExecutionHostId, type ExecutionHostId } from '../execution-host/execution-host'
import { isTuiAgent } from '../agent-launch/catalog/tui-agent-config'
import { tabContentTypeSchema } from './workspace-session-tab-type-schema'
import { isStructuredAgentId } from '../agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

export const executionHostIdSchema = lazyZodSchema(() =>
  z.custom<ExecutionHostId>(
    (value) => typeof value === 'string' && Boolean(parseExecutionHostId(value))
  )
)

export const terminalTabSchema = lazyZodSchema(() =>
  z.object({
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
        title: z.string(),
        kind: z.enum(['named', 'fallback']).optional().catch(undefined)
      })
      .nullable()
      .optional()
      .catch(undefined),
    quickCommandLabel: z.string().nullable().optional(),
    customTitle: z.string().nullable(),
    color: z.string().nullable(),
    isPinned: z.boolean().optional(),
    // Preserve chat ownership through restore; missing/unknown modes safely default to terminal, matching unified tabs.
    viewMode: z.enum(['terminal', 'chat']).catch('terminal').optional(),
    sortOrder: z.number(),
    createdAt: z.number(),
    generation: z.number().optional(),
    startupCwd: z.string().min(1).optional(),
    // Retain the idle agent icon before hooks fire; unknown IDs degrade to absent without resetting the session.
    launchAgent: z
      .custom<TuiAgent>((v) => isTuiAgent(v))
      .optional()
      .catch(undefined)
  })
)

export const tabSchema = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    entityId: z.string(),
    groupId: z.string(),
    worktreeId: z.string(),
    executionHostId: executionHostIdSchema.optional(),
    contentType: tabContentTypeSchema,
    // Accept registered agent slugs across mixed versions; invalid slugs become absent rather than rejecting the session.
    agentSessionAgent: z
      .string()
      .refine((value) => isStructuredAgentId(value))
      .optional()
      .catch(undefined),
    label: z.string(),
    generatedLabel: z.string().nullable().optional(),
    aiVaultTitle: z
      .object({
        agent: z.enum(['claude', 'codex']),
        sessionId: z.string(),
        title: z.string(),
        kind: z.enum(['named', 'fallback']).optional().catch(undefined)
      })
      .nullable()
      .optional()
      .catch(undefined),
    quickCommandLabel: z.string().nullable().optional(),
    customLabel: z.string().nullable(),
    color: z.string().nullable(),
    sortOrder: z.number(),
    createdAt: z.number(),
    // Why: corrupt optional recency must not discard the whole persisted tab.
    lastFocusedAt: z.number().finite().nonnegative().optional().catch(undefined),
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
    // Preserve chat mode on restore; unknown future values degrade to terminal and missing legacy values remain absent.
    viewMode: z.enum(['terminal', 'chat']).catch('terminal').optional()
  })
)

export const tabGroupSchema = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    worktreeId: z.string(),
    activeTabId: z.string().nullable(),
    tabOrder: z.array(z.string()),
    recentTabIds: z.array(z.string()).optional()
  })
)

const tabGroupSplitDirectionSchema = lazyZodSchema(() => z.enum(['horizontal', 'vertical']))

export const tabGroupLayoutNodeSchema: z.ZodType<TabGroupLayoutNode> = lazyZodSchema(() =>
  z.lazy(() =>
    z.discriminatedUnion('type', [
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
)
