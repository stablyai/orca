import { isClaudeAgent } from '../../../../../shared/agent-status/title/agent-title-identity'
import { detectAgentStatusFromTitle as classifyTitleActivity } from '../../../../../shared/agent-status/title/agent-title-status'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { PromptCacheTimerEntry } from '@/store/terminals/terminal-state'
import {
  hasPromptCacheRequest,
  promptCacheRestStartedAt,
  restoredTitleShowsPromptCacheRequest,
  type LiveClaudeEvidence
} from '@/lib/agent-status/evidence/prompt-cache-request-evidence'

type RestoredPromptCacheWait = 'await-hook-row' | 'await-process-read'

/** What a pane's first title restores: the cache entry to write, nothing, or the evidence that still decides. */
export function shouldSeedCacheTimerOnInitialTitle(args: {
  rawTitle: string
  allowInitialIdleSeed: boolean
  existing: PromptCacheTimerEntry | undefined
  promptCacheTimerEnabled: boolean | null
  agentStatusHooksEnabled: boolean | null
  entry: AgentStatusEntry | undefined
  liveClaude: LiveClaudeEvidence
  now: number
}): PromptCacheTimerEntry | RestoredPromptCacheWait | null {
  const { rawTitle, allowInitialIdleSeed, existing, promptCacheTimerEnabled, entry, now } = args
  if (typeof existing === 'number') {
    return null
  }
  const titleNamesClaude = isClaudeAgent(rawTitle)
  const status = titleNamesClaude ? classifyTitleActivity(rawTitle) : null
  if (status === 'working') {
    if (existing !== undefined) {
      return null
    }
    const shows = restoredTitleShowsPromptCacheRequest(rawTitle, entry, args.liveClaude)
    return shows === 'await-process-read' ? shows : shows ? 'requested' : null
  }
  // Fresh idle launches have no prompt cache (#442), so only reattached panes seed.
  if (!allowInitialIdleSeed) {
    return null
  }
  if (!titleNamesClaude) {
    // A named Claude session titles the pane with its bare name, so its row needs a live Claude behind it.
    if (entry?.agentType !== 'claude' || args.liveClaude === false) {
      return null
    }
    if (args.liveClaude === 'unread') {
      return 'await-process-read'
    }
  } else if (status === null) {
    return null
  } else if (entry === undefined) {
    // Hookless panes never get a row, so there is nothing to wait for.
    return args.agentStatusHooksEnabled === false ? null : 'await-hook-row'
  }
  if (!hasPromptCacheRequest(entry)) {
    return null
  }
  const restStartedAt = promptCacheRestStartedAt(entry, now)
  return restStartedAt !== null && promptCacheTimerEnabled !== false ? restStartedAt : 'requested'
}
