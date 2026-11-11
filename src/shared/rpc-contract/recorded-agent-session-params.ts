import { z } from 'zod'
import { parsePaneKey } from '../workspace-layout/stable-pane-id'
import { RESUMABLE_TUI_AGENTS } from '../agent-session/lifecycle/agent-session-resume'
import { ProviderSession, WorktreeSelector } from './agent-session-params'

export const RecordedAgentSessionsParams = z.object({ worktree: WorktreeSelector }).strict()

export const ResumeRecordedAgentSessionParams = z
  .object({
    worktree: WorktreeSelector,
    paneKey: z
      .string()
      .max(1024)
      .refine((value) => parsePaneKey(value) !== null)
      .optional(),
    agent: z.enum(RESUMABLE_TUI_AGENTS).optional(),
    sessionId: ProviderSession.shape.id.optional()
  })
  .strict()
  .refine((value) => value.paneKey !== undefined || (value.agent && value.sessionId), {
    message: 'Specify a pane key, or both an agent and a provider session ID'
  })
