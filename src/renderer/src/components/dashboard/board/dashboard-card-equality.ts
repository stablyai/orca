import type { DashboardCard } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'

function sameSubagents(a: DashboardCard['subagents'], b: DashboardCard['subagents']): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return false
  }
  for (let index = 0; index < a.length; index += 1) {
    if (!(index in a) || !(index in b)) {
      if (index in a !== index in b) {
        return false
      }
      continue
    }
    const subagent = a[index]
    const other = b[index]
    if (
      subagent.id !== other.id ||
      subagent.name !== other.name ||
      subagent.dotState !== other.dotState
    ) {
      return false
    }
  }
  return true
}

export function sameDashboardCard(a: DashboardCard, b: DashboardCard): boolean {
  return (
    a.paneKey === b.paneKey &&
    a.ptyId === b.ptyId &&
    a.agentType === b.agentType &&
    a.bucket === b.bucket &&
    a.dotState === b.dotState &&
    a.workingMode === b.workingMode &&
    a.verdict === b.verdict &&
    a.task === b.task &&
    a.lastUserMessage === b.lastUserMessage &&
    a.lastAgentMessage === b.lastAgentMessage &&
    a.repoId === b.repoId &&
    a.worktreeId === b.worktreeId &&
    a.tabId === b.tabId &&
    a.leafId === b.leafId &&
    a.repoName === b.repoName &&
    a.worktreeName === b.worktreeName &&
    a.hostKind === b.hostKind &&
    a.executionHostId === b.executionHostId &&
    a.hostLabel === b.hostLabel &&
    a.hasReview === b.hasReview &&
    a.review?.number === b.review?.number &&
    a.review?.state === b.review?.state &&
    sameSubagents(a.subagents, b.subagents) &&
    a.startedAt === b.startedAt &&
    a.finishedAt === b.finishedAt &&
    a.stateChangedAt === b.stateChangedAt &&
    a.unseen === b.unseen &&
    a.askSummary === b.askSummary &&
    a.conversationName === b.conversationName
  )
}
