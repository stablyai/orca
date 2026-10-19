// `layout.apply`'s sleep and wake commands (see LayoutApplyParams).
import { z } from 'zod'
import { parsePaneKey } from '../stable-pane-id'
import { sleepingAgentSessionRecordSchema } from '../workspace-session-sleeping-agents'

// copied, not imported: import cycle
const OnTab = { workspace: z.string().min(1), tabId: z.string().min(1) }

/** Pane keys of the command's own tab only, so a sleep or wake never reaches past it. */
function paneKeysNameTab(command: { tabId: string; paneKeys: string[] }): boolean {
  return command.paneKeys.every((paneKey) => parsePaneKey(paneKey)?.tabId === command.tabId)
}

/**
 * The window's sleep of panes of one tab it already stopped; main records how each resumes.
 * `recordOnly`: a resume record of a running agent (a live or quit capture); nothing stops.
 */
export const SleepCommand = z
  .object({
    type: z.literal('sleep'),
    ...OnTab,
    paneKeys: z.array(z.string().min(1)).min(1),
    records: z.array(sleepingAgentSessionRecordSchema),
    recordOnly: z.literal(true).optional()
  })
  .refine(paneKeysNameTab)
  .refine((command) =>
    command.records.every(
      (record) =>
        record.worktreeId === command.workspace && command.paneKeys.includes(record.paneKey)
    )
  )

/**
 * The window's wake of the one pane it shows; never more, so agents are not resumed in bulk.
 * `recordOnly`: the window dropped the panes' resume records; nothing starts, so any count.
 */
export const WakeCommand = z
  .object({
    type: z.literal('wake'),
    ...OnTab,
    paneKeys: z.array(z.string().min(1)).min(1),
    recordOnly: z.literal(true).optional()
  })
  .refine((command) => command.recordOnly === true || command.paneKeys.length === 1)
  .refine(paneKeysNameTab)
