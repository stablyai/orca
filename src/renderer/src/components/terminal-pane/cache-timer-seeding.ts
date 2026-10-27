import { isClaudeAgent } from '@/lib/agent-status'
import { classifyTitleActivity } from '@/lib/pane-agent-evidence'

export function shouldSeedCacheTimerOnInitialTitle(args: {
  rawTitle: string
  allowInitialIdleSeed: boolean
  existingTimerStartedAt: number | null | undefined
  promptCacheTimerEnabled: boolean | null
}): boolean {
  const { rawTitle, allowInitialIdleSeed, existingTimerStartedAt, promptCacheTimerEnabled } = args

  if (!allowInitialIdleSeed || !isClaudeAgent(rawTitle)) {
    return false
  }

  const status = classifyTitleActivity(rawTitle)
  if (status === null || status === 'working') {
    return false
  }

  if (existingTimerStartedAt != null) {
    return false
  }

  // Seed countdowns only on restored PTYs; fresh idle launches have no server prompt cache yet.
  return promptCacheTimerEnabled !== false
}
