import { z } from 'zod'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'

// Why: this is a receive-side contract on content a newer host may extend (wire-compat Rule 3), so it
// pins only the fields recovery and the mirror's coordinate logic read. Labels such as tab kinds,
// agent names, and status enums stay open; additive fields at every depth pass through untouched.
const identity = z.string().regex(/\S/)
const nullableString = z.string().nullable()
const version = z.number().int().nonnegative()

const paneLayout: z.ZodType<TerminalPaneLayoutNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('leaf'), leafId: identity }),
    z.object({ type: z.literal('split'), first: paneLayout, second: paneLayout })
  ])
) as z.ZodType<TerminalPaneLayoutNode>
const groupLayout: z.ZodType<TabGroupLayoutNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('leaf'), groupId: identity }),
    z.object({ type: z.literal('split'), first: groupLayout, second: groupLayout })
  ])
) as z.ZodType<TabGroupLayoutNode>

const tabRowFields = { id: identity, title: z.string(), isActive: z.boolean() }
const terminalRow = z.object({
  ...tabRowFields,
  type: z.literal('terminal'),
  parentTabId: identity,
  leafId: identity,
  ptyId: nullableString.optional(),
  incarnationId: nullableString.optional(),
  parentLayout: z
    .object({
      root: paneLayout.nullable(),
      activeLeafId: nullableString,
      expandedLeafId: nullableString,
      ptyIdsByLeafId: z.record(z.string(), z.string()).optional()
    })
    .optional()
})
const terminalRows = z.union([
  terminalRow.extend({ status: z.literal('pending-handle'), terminal: z.null() }),
  terminalRow.extend({ status: z.literal('ready'), terminal: identity })
])
// Non-terminal rows only need the identity the mirror keys on; their kind may postdate this client.
const otherRow = z.object({
  ...tabRowFields,
  type: z.string().refine((type) => type !== 'terminal')
})

const snapshotSchema = z.object({
  worktree: identity,
  publicationEpoch: identity,
  snapshotVersion: version,
  activeGroupId: nullableString,
  activeTabId: nullableString,
  activeTabType: nullableString,
  tabGroups: z
    .array(
      z.object({
        id: identity,
        activeTabId: nullableString,
        tabOrder: z.array(z.string()),
        recentTabIds: z.array(z.string()).optional()
      })
    )
    .optional(),
  tabGroupLayout: groupLayout.nullable().optional(),
  retiredTerminalSurfaces: z
    .array(
      z.object({
        parentTabId: identity,
        leafId: identity,
        ptyId: z.string(),
        terminal: identity,
        incarnationId: z.string().optional()
      })
    )
    .optional(),
  tabs: z.array(z.union([terminalRows, otherRow]))
})

export function isTerminalRecoverySnapshot(
  value: unknown
): value is RuntimeMobileSessionTabsResult {
  try {
    // Validate without replacing the payload: additive fields survive, malformed rows never get salvaged.
    return snapshotSchema.safeParse(value).success
  } catch {
    return false
  }
}
