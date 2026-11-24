import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../component-fixtures/component-fixture'
import TabBar from './TabBar'

const WORKSPACE_ID = 'side-chat-pane-fixture'
const TITLES = [
  'Review the API',
  'Check migration options',
  'Explain this result',
  'Compare approaches'
]
const noop = (): void => {}

const sidePaneTabs: (Tab & { contentType: 'agent-session' })[] = TITLES.map((label, index) => ({
  id: `side-${index}`,
  entityId: `side-session-${index}`,
  worktreeId: WORKSPACE_ID,
  groupId: 'tab-width-group',
  contentType: 'agent-session',
  agentSessionAgent: 'codex',
  executionHostId: 'local',
  label,
  customLabel: null,
  color: null,
  sortOrder: index,
  createdAt: index
}))

export const sideChatPane = defineFixture({
  width: 480,
  store: { unifiedTabsByWorktree: { [WORKSPACE_ID]: sidePaneTabs } },
  setup: () => {
    const subscribe = window.api.runtime.subscribe
    window.api.runtime.subscribe = async (request, onResponse) => {
      if (request.method !== 'agentSession.subscribeStatus') {
        return subscribe.call(window.api.runtime, request, onResponse)
      }
      const delivery = setTimeout(() => {
        onResponse({
          id: 'side-pane-fixture',
          ok: true,
          _meta: { runtimeId: 'fixture' },
          result: {
            type: 'snapshot',
            sessions: [],
            namingActiveSessionIds: [],
            conversationNames: sidePaneTabs.map((tab) => ({
              sessionId: tab.entityId,
              conversationName: tab.label,
              sideChat: {
                sourceSessionId: 'source-session',
                sourceProviderSessionId: 'source-provider'
              }
            }))
          }
        })
      })
      return { unsubscribe: () => clearTimeout(delivery), sendBinary: noop }
    }
    return () => {
      window.api.runtime.subscribe = subscribe
    }
  },
  render: () => (
    <DndContext>
      <div className="@container/tab-strip h-8 bg-card">
        <TabBar
          tabs={[]}
          agentSessionTabs={sidePaneTabs}
          tabBarOrder={sidePaneTabs.map((tab) => tab.id)}
          activeTabId="side-0"
          activeTabType="agent-session"
          worktreeId={WORKSPACE_ID}
          groupId="tab-width-group"
          expandedPaneByTabId={{}}
          showAgentLaunchItems={false}
          onActivate={noop}
          onClose={noop}
          onCloseOthers={noop}
          onCloseToRight={noop}
          onCloseToLeft={noop}
          onNewTerminalTab={noop}
          onNewBrowserTab={noop}
          onSetCustomTitle={noop}
          onSetTabColor={noop}
          onTogglePaneExpand={noop}
        />
      </div>
    </DndContext>
  ),
  interact: async (frame) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (frame.querySelector('[data-side-chat-only="true"]')) {
        return
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    throw new Error('Side-chat pane naming did not arrive')
  }
})
