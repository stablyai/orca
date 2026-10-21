// The terminal tab creates `layout.apply` takes, and the new-group split every tab open shares.

import { z } from 'zod'
import { isTerminalLeafId } from '../stable-pane-id'
import { isValidHostTerminalTabId } from '../terminal-tab-id'
import type { TuiAgent } from '../tui-agent'
import { isTuiAgent } from '../tui-agent-config'

const workspace = z.string().min(1)

/** An open into a new group, named by the command's groupId, beside this one (NewGroupSplit). */
export const NewGroupSplit = z
  .object({
    besideGroupId: z.string().min(1),
    besideLastGroupId: z.string().min(1).optional(),
    direction: z.enum(['left', 'right', 'up', 'down'])
  })
  .optional()

const TerminalCreation = z.object({
  defaultTitle: z.string().min(1).optional(),
  shellOverride: z.string().min(1).optional(),
  startupCwd: z.string().min(1).optional(),
  forceHostRuntime: z.literal(true).optional(),
  launchAgent: z
    .custom<TuiAgent>((value) => typeof value === 'string' && isTuiAgent(value))
    .optional()
})

/**
 * A terminal tab under the ids the window drew it with: its callers and the pane's terminal need
 * them at once. Main refuses an id another tab holds; the same create again changes nothing.
 */
export const CreateTerminalTabCommand = z.object({
  type: z.literal('createTerminalTab'),
  workspace,
  tabId: z.string().refine(isValidHostTerminalTabId),
  leafId: z.string().refine(isTerminalLeafId),
  groupId: z.string().min(1).optional(),
  viewMode: z.enum(['terminal', 'chat']).optional(),
  createdAt: z.number().int().nonnegative().optional(),
  quickCommandLabel: z.string().trim().min(1).optional(),
  creation: TerminalCreation.optional(),
  /** Only into a workspace with no tab in main's copy; otherwise nothing is created. */
  initial: z.literal('activation').optional(),
  split: NewGroupSplit
})

/**
 * A workspace's default terminal tabs, in order, under the ids the window proposes; main makes none
 * once the workspace is marked, and refuses an id another tab holds.
 */
export const ApplyDefaultTabsCommand = z.object({
  type: z.literal('applyDefaultTabs'),
  workspace,
  tabs: z.array(
    z.object({
      tabId: z.string().refine(isValidHostTerminalTabId),
      leafId: z.string().refine(isTerminalLeafId),
      title: z.string().trim().min(1).optional(),
      color: z.string().min(1).optional(),
      creation: TerminalCreation.optional()
    })
  )
})
