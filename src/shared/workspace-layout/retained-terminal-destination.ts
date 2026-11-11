import type { TabGroup, TabGroupLayoutNode } from '../tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from './terminal-tab-types'
import type { RetainedTerminalStart } from './retained-terminal-start'
import { retainedTerminalStart } from './retained-terminal-start'
import {
  terminalTabSchema,
  tabGroupSchema,
  tabGroupLayoutNodeSchema
} from '../workspace-session/workspace-session-schema'
import { terminalLayoutSnapshotSchema } from './terminal-layout-snapshot-schema'
import { collectLeafIds } from './terminal-pane-layout-tree'
import { z } from 'zod'

export const retainedTerminalDestination = z
  .object({
    start: retainedTerminalStart,
    tab: terminalTabSchema.extend({ shellOverride: z.string().optional() }),
    layout: terminalLayoutSnapshotSchema,
    group: tabGroupSchema.optional(),
    groupLayout: tabGroupLayoutNodeSchema.optional()
  })
  .refine(
    ({ start, tab, layout, group }) =>
      tab.id === start.tabId &&
      tab.worktreeId === start.worktreeId &&
      collectLeafIds(layout.root).includes(start.leafId) &&
      (!group || (group.worktreeId === start.worktreeId && group.tabOrder.includes(tab.id)))
  )

export const terminalStartupRestoration = z.object({
  retainedTerminalStarts: z.array(retainedTerminalDestination)
})

/** Current addressed layout for a transient host-owned start, never a saved failure flag. */
export type RetainedTerminalDestination = {
  start: RetainedTerminalStart
  tab: TerminalTab
  layout: TerminalLayoutSnapshot
  group?: TabGroup
  groupLayout?: TabGroupLayoutNode
}

export type TerminalStartupRestoration = {
  retainedTerminalStarts: RetainedTerminalDestination[]
}
