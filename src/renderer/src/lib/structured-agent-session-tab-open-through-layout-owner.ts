// Send open with the chat’s own tab ID, select only after main draws it, and use afterPendingTab before reading the returned tab from store.

import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { defaultAgentChatLabel } from '../../../shared/agent-session/agent-session-chat-label'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { useAppStore } from '@/store'
import { openContentTabThroughLayoutOwner } from '@/runtime/layout-owner-content-tab-open'
import { hasPendingEntityTab } from '@/runtime/layout-owner-pending-tabs'
import { contentTabOpenPlacement } from '@/store/slices/tabs/content-tab-open-placement'

export type AgentSessionTabOpen = {
  worktreeId: string
  executionHostId: ExecutionHostId
  sessionId: string
  agent: TuiAgent
  targetGroupId?: string
  afterTabId?: string
  activate: boolean
  /** Today's draw, for a twin main may route to a paired server. */
  drawHere: () => Tab
}

/** What a caller may rely on before main's frame draws the tab: its id and the chat it shows. */
export type OpenedAgentSessionTab = Pick<Tab, 'id' | 'entityId'>

/** Null when main is not asked (a paired server owns the workspace's layout): draw as today. */
export function openAgentSessionTabThroughLayoutOwner(
  open: AgentSessionTabOpen
): OpenedAgentSessionTab | null {
  const { worktreeId, sessionId } = open
  const state = useAppStore.getState()
  const tabId = structuredAgentSessionTabId(sessionId)
  const label = defaultAgentChatLabel(open.agent)
  const placement = contentTabOpenPlacement(state, worktreeId, tabId, {
    targetGroupId: open.targetGroupId,
    afterTabId: open.afterTabId,
    executionHostId: open.executionHostId
  })
  if (!placement) {
    return null
  }
  const tab = { id: tabId, entityId: sessionId }
  // A second launch of the same chat waits for the first open.
  if (hasPendingEntityTab(worktreeId, sessionId)) {
    return tab
  }
  const sent = openContentTabThroughLayoutOwner(state, {
    worktreeId,
    entityId: sessionId,
    command: { type: 'openAgentSessionTab', tabId, sessionId, agent: open.agent, ...placement },
    facts: { label },
    shown: (shownId) => {
      if (!open.activate) {
        return
      }
      // As the window's own open: the chat is selected in its group; the focused group stays.
      const current = useAppStore.getState()
      current.activateTab(shownId, { worktreeId })
      current.setActiveTabType('agent-session', worktreeId)
    },
    drawHere: () => open.drawHere().id
  })
  return sent ? tab : null
}
