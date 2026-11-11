import { z } from 'zod'
import { isTerminalLeafId } from '../workspace-layout/stable-pane-id'

export const SessionReadTerminalHistoryParams = z.object({
  worktreeId: z.string().min(1),
  tabId: z.string().min(1).max(256),
  leafId: z.string().refine(isTerminalLeafId),
  executionHostId: z.string().min(1).optional(),
  expectedSessionId: z.string().min(1).max(512).optional()
})

export type SessionReadTerminalHistoryRequest = z.infer<typeof SessionReadTerminalHistoryParams>
export type SessionReadTerminalHistoryResult =
  | { status: 'absent' | 'ambiguous' | 'unsupported' | 'unreadable' | 'changed' }
  | {
      status: 'restored'
      scrollback: string
      cols: number
      rows: number
      partial: boolean
    }
