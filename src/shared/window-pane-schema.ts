import { z } from 'zod'
import { parseExecutionHostId } from './execution-host'
import type { TabGroupLayoutNode } from './tab-types'
import type { WindowPaneLayout } from './window-pane-types'

const LayoutNode: z.ZodType<TabGroupLayoutNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('leaf'), groupId: z.string() }),
    z.object({
      type: z.literal('split'),
      direction: z.enum(['horizontal', 'vertical']),
      first: LayoutNode,
      second: LayoutNode,
      ratio: z.number().min(0.15).max(0.85).optional()
    })
  ])
)

export const WindowPaneLayoutSchema: z.ZodType<WindowPaneLayout> = z
  .object({
    version: z.literal(1),
    root: LayoutNode,
    activePaneId: z.string(),
    expandedPaneId: z.string().nullable(),
    panes: z.record(
      z.string(),
      z.object({
        id: z.string(),
        viewIds: z.array(z.string()),
        selectedViewId: z.string().nullable(),
        workspace: z
          .object({
            worktreeId: z.string(),
            executionHostId: z
              .string()
              .refine((value) => !!parseExecutionHostId(value))
              .transform((value) => parseExecutionHostId(value)!.id)
          })
          .optional(),
        dismissedTabKeys: z.array(z.string()).optional()
      })
    ),
    views: z.record(
      z.string(),
      z.object({
        id: z.string(),
        executionHostId: z.string().transform((value, ctx) => {
          const host = parseExecutionHostId(value)
          if (!host) {
            ctx.addIssue({ code: 'custom', message: 'Invalid execution host' })
            return z.NEVER
          }
          return host.id
        }),
        worktreeId: z.string(),
        tabId: z.string(),
        entityId: z.string(),
        label: z.string().optional(),
        contentType: z.enum([
          'terminal',
          'editor',
          'diff',
          'conflict-review',
          'check-details',
          'agent-session',
          'browser',
          'simulator'
        ])
      })
    )
  })
  .refine((layout) => {
    const leaves: string[] = []
    const visit = (node: TabGroupLayoutNode): void => {
      if (node.type === 'leaf') {
        leaves.push(node.groupId)
      } else {
        visit(node.first)
        visit(node.second)
      }
    }
    visit(layout.root)
    const views = Object.values(layout.panes).flatMap((pane) => pane.viewIds)
    return (
      !!layout.panes[layout.activePaneId] &&
      (!layout.expandedPaneId || !!layout.panes[layout.expandedPaneId]) &&
      leaves.length === Object.keys(layout.panes).length &&
      new Set(leaves).size === leaves.length &&
      leaves.every((id) => layout.panes[id]?.id === id) &&
      new Set(views).size === views.length &&
      views.length === Object.keys(layout.views).length &&
      views.every((id) => layout.views[id]?.id === id) &&
      Object.values(layout.panes).every(
        (pane) => pane.selectedViewId === null || pane.viewIds.includes(pane.selectedViewId)
      )
    )
  })

export function parseWindowPaneLayout(value: unknown): WindowPaneLayout | null {
  const parsed = WindowPaneLayoutSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
