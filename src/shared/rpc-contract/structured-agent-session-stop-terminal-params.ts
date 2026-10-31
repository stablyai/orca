import { z } from 'zod'
import { Identifier } from './structured-agent-session-identifiers'
import { StructuredAgent } from './structured-agent-session-params'

export const StopTerminalAgentForChatParams = z
  .object({
    worktree: Identifier('Invalid worktree selector'),
    agent: StructuredAgent,
    providerSessionId: Identifier('Invalid provider session id'),
    cliSource: z
      .object({
        workspaceId: Identifier('Invalid workspace id'),
        paneKey: Identifier('Invalid pane key')
      })
      .strict()
  })
  .strict()
