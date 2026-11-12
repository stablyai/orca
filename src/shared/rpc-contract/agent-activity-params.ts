import { z } from 'zod'

// Bounded like a worktree.ps page of agent rows; pane keys are `${tabId}:${leafUuid}`.
const AgentActivityPaneKeys = z.array(z.string().min(1).max(512)).min(1).max(500)

export const AgentActivitySetReadParams = z.object({
  paneKeys: AgentActivityPaneKeys,
  read: z.boolean()
})

export const AgentActivityClearParams = z.object({ paneKeys: AgentActivityPaneKeys })
