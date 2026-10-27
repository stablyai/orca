import { useAppStore } from '@/store'
import { sameStructuredReadTarget } from '@/attention/agent-subject-read-actions'
import { structuredAgentSessionTargetForTab } from '@/runtime/structured-agent-session-owner'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { createTerminalGitHubPRLinkDetector } from '../../../../shared/terminal-github-pr-link-detector'
import { getStructuredAgentSessionTabs } from './structured-agent-session-tabs'

/** Records PRs a chat's tools print (e.g. `gh pr create`) on its workspace, like terminal output. */
export function createStructuredAgentSessionPRLinkObserver(
  sessionId: string,
  target: RuntimeClientTarget
): (event: AgentSessionSubscribeEvent) => void {
  const detect = createTerminalGitHubPRLinkDetector()
  return (event) => {
    // Why: only live batches; replayed history would re-link PRs the user may have unlinked.
    if (event.type !== 'batch') {
      return
    }
    const links = event.batch.items.flatMap((item) =>
      item.body.kind === 'tool-call' && item.body.output?.head
        ? detect(`${item.body.output.head}\n`)
        : []
    )
    if (!links.length) {
      return
    }
    const state = useAppStore.getState()
    const tab = getStructuredAgentSessionTabs(state.unifiedTabsByWorktree).find((candidate) => {
      const tabTarget =
        candidate.entityId === sessionId && structuredAgentSessionTargetForTab(state, candidate)
      return Boolean(tabTarget && sameStructuredReadTarget(tabTarget, target))
    })
    if (!tab) {
      return
    }
    for (const link of links) {
      state.observeTerminalGitHubPullRequestLink(tab.worktreeId, link, {
        kind: 'agent-session',
        tabId: tab.id
      })
    }
  }
}
