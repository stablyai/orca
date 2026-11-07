// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'
import { useWorktreeActivityStatuses } from './use-worktree-activity-statuses'
import {
  PaletteLiveStatusProvider,
  PaletteWorktreeStatusDot
} from '@/components/cmd-j/palette-live-status'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { Tab } from '../../../../../../shared/tab-types'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
const TARGET_WORKTREE_ID = 'repo-1::/repo/wt-0'
const originalState = useAppStore.getState()
let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
  useAppStore.setState(originalState, true)
  vi.restoreAllMocks()
})

type ChatStatusConsumer = 'sidebar' | 'parent picker' | 'palette'
function ChatSidebarProbe({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  return <span data-chat-status>{useWorktreeActivityStatus(worktreeId)}</span>
}
function ChatParentPickerProbe({ ids }: { ids: readonly string[] }): React.JSX.Element {
  const statuses = useWorktreeActivityStatuses(ids)
  return (
    <>
      {ids.map((id) => (
        <span key={id} data-chat-status>
          {statuses.get(id)}
        </span>
      ))}
    </>
  )
}

function mountChatConsumers(consumer: ChatStatusConsumer): void {
  const tab: Tab = {
    id: 'chat-0-0',
    entityId: 'session-0-0',
    worktreeId: TARGET_WORKTREE_ID,
    groupId: 'group-1',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  useAppStore.setState({
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    unifiedTabsByWorktree: { [TARGET_WORKTREE_ID]: [tab] },
    structuredChatSleptAtByPaneKey: { [structuredAgentSessionPaneKey(tab.id, tab.entityId)]: 1 }
  })
  const ids = [TARGET_WORKTREE_ID]
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const content =
    consumer === 'parent picker' ? (
      <ChatParentPickerProbe ids={ids} />
    ) : consumer === 'sidebar' ? (
      <ChatSidebarProbe worktreeId={TARGET_WORKTREE_ID} />
    ) : (
      <PaletteLiveStatusProvider active>
        <span data-chat-status>
          <PaletteWorktreeStatusDot worktree={{ id: TARGET_WORKTREE_ID }} />
        </span>
      </PaletteLiveStatusProvider>
    )
  act(() => root?.render(<TooltipProvider>{content}</TooltipProvider>))
}

function chatStatusLabels(): string[] {
  return Array.from(
    container?.querySelectorAll('[data-chat-status]') ?? [],
    (node) => node.textContent?.trim().toLowerCase() ?? ''
  )
}

describe.each<ChatStatusConsumer>(['sidebar', 'parent picker', 'palette'])(
  '%s chat-only status subscriptions',
  (consumer) => {
    it('observes chat evidence live while preserving agent priority', () => {
      const now = 1_000
      vi.spyOn(Date, 'now').mockReturnValue(now)
      mountChatConsumers(consumer)
      expect(chatStatusLabels()).toEqual(['inactive'])
      const tab = useAppStore.getState().unifiedTabsByWorktree[TARGET_WORKTREE_ID][0]
      const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
      act(() => useAppStore.getState().setStructuredChatSleptAt(paneKey, undefined))
      expect(chatStatusLabels()).toEqual(['active'])
      act(() => useAppStore.getState().setStructuredChatSleptAt(paneKey, 1))
      expect(chatStatusLabels()).toEqual(['inactive'])
      act(() => useAppStore.getState().setStructuredChatSleptAt(paneKey, null))
      expect(chatStatusLabels()).toEqual(['active'])
      const working: AgentStatusEntry = {
        paneKey,
        worktreeId: TARGET_WORKTREE_ID,
        state: 'working',
        prompt: '',
        updatedAt: now,
        stateStartedAt: now,
        stateHistory: []
      }
      act(() =>
        useAppStore.setState({ agentStatusByPaneKey: { [paneKey]: working }, agentStatusEpoch: 1 })
      )
      expect(chatStatusLabels()).toEqual(['working'])
      if (consumer !== 'palette') {
        act(() =>
          useAppStore.setState({
            agentStatusByPaneKey: { [paneKey]: { ...working, state: 'done' } },
            agentStatusEpoch: 2
          })
        )
        expect(chatStatusLabels()).toEqual(['done'])
      }
      act(() =>
        useAppStore.setState({
          unifiedTabsByWorktree: {},
          agentStatusByPaneKey: {},
          agentStatusEpoch: 3
        })
      )
      expect(chatStatusLabels()).toEqual(['inactive'])
    })
  }
)
