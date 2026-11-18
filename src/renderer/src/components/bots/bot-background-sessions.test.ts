import { describe, expect, it } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type { Bot } from '../../../../shared/bot-types'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { botBackgroundSessionTabs, joinBotSessions } from './bot-background-sessions'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only folderWorkspaceId is read.
const bots = [{ folderWorkspaceId: 'fw-1' } as Bot]

function hostSessions(
  ...entries: [sessionId: string, workspaceId: string][]
): Map<string, AgentSessionStatusSummary> {
  return new Map(
    entries.map(([sessionId, workspaceId]) => [
      sessionId,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model reads only sessionId, workspaceId and agent.
      { sessionId, workspaceId, agent: 'claude' } as AgentSessionStatusSummary
    ])
  )
}

describe('botBackgroundSessionTabs', () => {
  it("stands in for a bot session's tab while it has none", () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only entityId is read.
    const openTab = { entityId: 'opened' } as Tab
    const sessions = botBackgroundSessionTabs(
      bots,
      [],
      hostSessions(['thread', 'folder:fw-1'], ['opened', 'folder:fw-1'], ['other', 'folder:fw-2']),
      { 'folder:fw-1': [openTab] }
    )

    expect(sessions).toEqual([
      expect.objectContaining({
        id: structuredAgentSessionTabId('thread'),
        entityId: 'thread',
        worktreeId: 'folder:fw-1',
        contentType: 'agent-session',
        agentSessionAgent: 'claude'
      })
    ])
  })

  it('joins the same background and tabs into the same list', () => {
    const background = botBackgroundSessionTabs(
      bots,
      [],
      hostSessions(['thread', 'folder:fw-1']),
      {}
    )
    const tabs = botBackgroundSessionTabs(bots, [], hostSessions(['other', 'folder:fw-1']), {})
    expect(joinBotSessions(background, tabs)).toBe(joinBotSessions(background, tabs))
    expect(joinBotSessions([], tabs)).toBe(tabs)
  })
})
