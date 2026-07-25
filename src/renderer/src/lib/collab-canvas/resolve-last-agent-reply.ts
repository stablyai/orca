/**
 * Find the freshest lastAssistantMessage for a session board's worktree agent.
 * Used for "Draft from last reply" — weak two-way until the agent can ink.
 */

export type AgentReplySource = {
  paneKey: string
  worktreeId?: string
  tabId?: string
  updatedAt?: number
  lastAssistantMessage?: string
  state?: string
}

export function resolveLastAgentReply(args: {
  worktreeId: string
  preferredTabId?: string | null
  entries: readonly AgentReplySource[]
}): { body: string; paneKey: string } | null {
  const wt = args.worktreeId
  const candidates = args.entries.filter((e) => {
    if (!e.lastAssistantMessage?.trim()) return false
    if (e.worktreeId === wt) return true
    if (args.preferredTabId && (e.tabId === args.preferredTabId || e.paneKey.startsWith(`${args.preferredTabId}:`))) {
      return true
    }
    return false
  })
  if (candidates.length === 0) return null
  candidates.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const best = candidates[0]
  const body = best.lastAssistantMessage?.trim()
  if (!body) return null
  return { body, paneKey: best.paneKey }
}
