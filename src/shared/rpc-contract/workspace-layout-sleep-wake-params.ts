import { z } from 'zod'
import { parsePaneKey } from '../stable-pane-id'
import { sleepingAgentSessionRecordSchema } from '../workspace-session-sleeping-agents'

// copied, not imported: import cycle
const OnTab = { workspace: z.string().min(1), tabId: z.string().min(1) }

/** Pane keys of the command's own tab only, so a sleep or wake never reaches past it. */
function paneKeysNameTab(command: { tabId: string; paneKeys: string[] }): boolean {
  return command.paneKeys.every((paneKey) => parsePaneKey(paneKey)?.tabId === command.tabId)
}

/** Record how already-stopped panes resume; recordOnly captures running agents without stopping them. */
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

/** Wake one shown pane to avoid bulk agent resumes; recordOnly drops any number of resume records without starting them. */
export const WakeCommand = z
  .object({
    type: z.literal('wake'),
    ...OnTab,
    paneKeys: z.array(z.string().min(1)).min(1),
    recordOnly: z.literal(true).optional()
  })
  .refine((command) => command.recordOnly === true || command.paneKeys.length === 1)
  .refine(paneKeysNameTab)

/** The window's start of one pane it shows that has no live terminal; main starts it, never the window. */
export const StartPaneCommand = z
  .object({ type: z.literal('startPane'), ...OnTab, paneKey: z.string().min(1) })
  .refine((command) => parsePaneKey(command.paneKey)?.tabId === command.tabId)
