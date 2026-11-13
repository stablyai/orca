import type { StructuredAgentSessionReadEffects } from './structured-agent-session-read-owner-contract'
import { sameStructuredReadTarget } from '@/attention/agent-subject-read-actions'
import { structuredAgentSessionTargetForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { AgentSessionSubscribeEvent } from '../../../../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
import { createTerminalGitHubPRLinkDetector } from '../../../../../../../shared/terminal/links/terminal-github-pr-link-detector'
import { getStructuredAgentSessionTabs } from '../../status/structured-agent-session-tabs'

/** Records PRs a chat's tools print (e.g. `gh pr create`) on its workspace, like terminal output. */
export function createStructuredAgentSessionPRLinkObserver(
  sessionId: string,
  target: RuntimeClientTarget
): (
  event: AgentSessionSubscribeEvent,
  readers: Iterable<StructuredAgentSessionReadEffects>
) => void {
  const detect = createTerminalGitHubPRLinkDetector()
  return (event, readers) => {
    // Why: only live batches; replayed history would re-link PRs the user may have unlinked.
    if (event.type !== 'batch') {
      return
    }
    const reader = Array.from(readers).find(
      (candidate) => candidate.observeWorkspaceLinks !== false
    )
    if (!reader) {
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
    const state = reader.getState()
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
