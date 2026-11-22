import { z } from 'zod'
import { TerminalHandle } from './terminal-unary-params'

/** Switches the Codex TUI in this pane to a thread; no `agentId` returns it to the main thread. */
export const TerminalViewCodexAgent = TerminalHandle.extend({
  sessionId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  client: z.object({ id: z.string().min(1).max(256), type: z.literal('desktop') })
})

export type CodexAgentViewResult = {
  status: 'viewed' | 'draft' | 'permission' | 'not_listed' | 'unavailable'
}
