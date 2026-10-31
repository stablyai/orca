import type { AgentStatusEntry } from './agent-status-types'
import { isAgentStatusFresh } from './agent-status-freshness'
import { isLiveChildWork } from './agent-status-child-work-liveness'

export function hasHoldQuitActiveWork(
  entries: Record<string, AgentStatusEntry>,
  now = Date.now()
): boolean {
  return Object.values(entries).some((entry) => {
    if (
      !isAgentStatusFresh(entry, now) ||
      entry.observation?.origin === 'launch' ||
      entry.observation?.origin === 'title'
    ) {
      return false
    }
    if (entry.mainAgent?.state === 'working' || entry.state === 'working') {
      return true
    }
    if (entry.children) {
      return entry.children.some(
        (child) =>
          child.membership === 'live' && child.state !== 'waiting' && isLiveChildWork(child)
      )
    }
    return (
      entry.subagents?.some(
        (child) =>
          child.state !== 'waiting' && isLiveChildWork({ kind: 'agent', state: child.state })
      ) === true
    )
  })
}
