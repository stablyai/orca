import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../component-fixtures/component-fixture'
import TabBarItemRow from './TabBarItemRow'
import { TabStripTooltipProvider } from './TabStripTooltipProvider'
import type { TabBarItem } from './tab-bar-item-model'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import { VaultSessionRow } from '../right-sidebar/ai-vault/session-list/AiVaultSessionRow'
import { CompactAgentRow } from '../sidebar/workspace-card/activity/worktree-card-compact-agent-row'
import type { DashboardAgentRow } from '../dashboard/rows/dashboard-agent-row'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { Tab } from '../../../../shared/tab-types'

const WORKTREE = 'repo-1::/repos/orca'

type Chat = {
  id: string
  /** The saved name as the host has it; the client derives what is shown. */
  name: string | null
  forkedFrom: { sessionId: string; plainName?: true } | null
  userNamed?: true
}

// Seeded naming frames, exactly as a current host publishes them.
const CHATS: Chat[] = [
  { id: 'original', name: 'Annotate capabilities', forkedFrom: null },
  {
    id: 'fork',
    name: 'Annotate capabilities',
    forkedFrom: { sessionId: 'original', plainName: true }
  },
  {
    id: 'fork-of-fork',
    name: 'Annotate capabilities',
    forkedFrom: { sessionId: 'fork', plainName: true }
  },
  { id: 'unnamed-fork', name: null, forkedFrom: { sessionId: 'original', plainName: true } },
  { id: 'plan', name: 'Plan the migration', forkedFrom: null },
  // Older build's title for "Plan the migration": the suffix is dropped.
  { id: 'legacy-fork', name: 'Plan the migration fork', forkedFrom: { sessionId: 'plan' } },
  // The source was renamed after forking: the old title no longer matches, so it stays.
  { id: 'legacy-renamed-source', name: 'Plan v1 fork', forkedFrom: { sessionId: 'plan' } },
  // The user typed this name: it is never cut.
  { id: 'user-named', name: 'Project fork', forkedFrom: { sessionId: 'plan' }, userNamed: true },
  // Its source is unknown to the host.
  { id: 'orphan', name: 'Review notes', forkedFrom: { sessionId: 'missing', plainName: true } }
]

function stubNamingFeed(): void {
  const runtime = window.api.runtime
  const subscribe = runtime.subscribe.bind(runtime)
  runtime.subscribe = async (request, onResponse) => {
    if (request.method !== 'agentSession.subscribeStatus') {
      return subscribe(request, onResponse)
    }
    setTimeout(() =>
      onResponse({
        id: 'fixture',
        ok: true,
        result: {
          type: 'snapshot',
          sessions: [],
          namingActiveSessionIds: [],
          conversationNames: CHATS.map((chat) => ({
            sessionId: chat.id,
            conversationName: chat.name,
            forkedFrom: chat.forkedFrom,
            ...(chat.userNamed ? { conversationNameSource: 'user' } : {})
          }))
        },
        _meta: { runtimeId: 'fixture' }
      })
    )
    return { unsubscribe: () => {}, sendBinary: () => {} }
  }
}

function chatTab(chat: Chat): Tab & { contentType: 'agent-session' } {
  return {
    id: `tab-${chat.id}`,
    entityId: chat.id,
    groupId: 'group',
    worktreeId: WORKTREE,
    executionHostId: 'local',
    contentType: 'agent-session',
    label: 'Claude Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    agentSessionAgent: 'claude'
  }
}

const noop = (): void => {}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a static strip never activates, closes or renames a tab.
const actions = new Proxy({}, { get: () => noop }) as TabBarItemActions

function TabStrip({ ids, width, activeId }: { ids: string[]; width?: number; activeId?: string }) {
  return (
    <DndContext>
      <TabStripTooltipProvider>
        <div className="flex h-8 items-stretch bg-card">
          {ids.map((id) => {
            const chat = CHATS.find((entry) => entry.id === id)!
            const item: TabBarItem = {
              type: 'agent-session',
              id: `tab-${id}`,
              unifiedTabId: `tab-${id}`,
              isPinned: false,
              data: chatTab(chat)
            }
            return (
              <div key={id} className="flex h-8" style={width ? { width } : undefined}>
                <TabBarItemRow
                  item={item}
                  actions={actions}
                  worktreeId={WORKTREE}
                  groupId="group"
                  generatedTabTitlesEnabled={false}
                  tabCount={ids.length}
                  hasTabsToLeft={false}
                  hasTabsToRight
                  isActive={id === activeId}
                  isExpanded={false}
                  dropIndicator={null}
                  includeTopTabBorder
                  canToggleViewMode={false}
                  isChatView
                  viewModeTabId={undefined}
                  canDuplicate={false}
                  canCloseSplitPane={false}
                  gitStatus={null}
                />
              </div>
            )
          })}
        </div>
      </TabStripTooltipProvider>
    </DndContext>
  )
}

const store = {
  unifiedTabsByWorktree: { [WORKTREE]: CHATS.map(chatTab) }
}

export const tabsFromFeed = defineFixture({
  width: 1280,
  store,
  setup: stubNamingFeed,
  render: () => (
    <div className="space-y-2">
      <TabStrip
        ids={['original', 'fork', 'fork-of-fork', 'unnamed-fork']}
        activeId="fork"
        width={300}
      />
      <TabStrip
        ids={['legacy-fork', 'legacy-renamed-source', 'user-named', 'orphan']}
        width={300}
      />
    </div>
  )
})

export const widthThreshold = defineFixture({
  width: 760,
  store,
  setup: stubNamingFeed,
  render: () => (
    <div className="space-y-2">
      <TabStrip ids={['fork', 'unnamed-fork']} width={179} activeId="fork" />
      <TabStrip ids={['fork', 'unnamed-fork']} width={180} activeId="fork" />
      <TabStrip ids={['fork', 'unnamed-fork']} width={181} activeId="fork" />
    </div>
  )
})

function hoverCard(id: string) {
  return defineFixture({
    width: 460,
    store,
    setup: stubNamingFeed,
    render: () => (
      <div className="h-40">
        <TabStrip ids={[id]} activeId={id} width={300} />
      </div>
    ),
    interact: async (frame) => {
      // Let the seeded naming snapshot land before the card reads it.
      await new Promise((resolve) => setTimeout(resolve, 50))
      frame.querySelector<HTMLElement>('[data-testid="sortable-tab"]')?.focus()
    }
  })
}

export const hoverForkOfFork = hoverCard('fork-of-fork')
export const hoverUnknownSource = hoverCard('orphan')

function vaultSession(chat: Chat, index: number): AiVaultSession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the collapsed row reads only these fields.
  return {
    id: `local:claude:${chat.id}`,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: chat.id,
    title: chat.name ?? 'Claude Chat',
    cwd: '/repos/orca',
    branch: 'main',
    model: null,
    filePath: `/tmp/${chat.id}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: new Date(Date.UTC(2026, 10, 14, 9, index)).toISOString(),
    modifiedAt: 0,
    messageCount: 4,
    totalTokens: 0,
    previewMessages: [{ role: 'assistant', text: 'Grouped the table by owner.' }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    structuredSession: { sessionId: chat.id, workspaceId: WORKTREE }
  } as unknown as AiVaultSession
}

export const sessionHistoryRows = defineFixture({
  width: 360,
  store,
  setup: stubNamingFeed,
  render: () => (
    <div className="divide-y divide-border bg-sidebar">
      {['fork', 'fork-of-fork', 'unnamed-fork', 'legacy-fork', 'user-named'].map((id, index) => (
        <VaultSessionRow
          key={id}
          session={vaultSession(
            CHATS.find((chat) => chat.id === id)!,
            index
          )}
          liveState={null}
          resumeStartup={{ command: '' }}
          realHomeResumeStartup={{ command: '' }}
          worktreeInfo={null}
          vaultScope="all"
          detailsExpanded={false}
          resumeDisabled
          onToggleDetails={noop}
          showJumpToWorktree={false}
          onResume={noop}
          resumeLabel="Resume"
          resumeActions={{
            worktree: { worktreeId: null, disabled: true },
            newTab: { worktreeId: null, disabled: true }
          }}
          onResumeInWorktree={noop}
          onResumeInNewTab={noop}
          onCopyId={noop}
        />
      ))}
    </div>
  )
})

function agentRow(chat: Chat, index: number): DashboardAgentRow {
  const tab = chatTab(chat)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the compact row reads only these fields.
  return {
    paneKey: `${tab.id}:chat`,
    entry: {
      state: 'done',
      prompt: '',
      updatedAt: Date.UTC(2026, 10, 14, 9, index),
      stateStartedAt: Date.UTC(2026, 10, 14, 9, index),
      lastAssistantMessage: 'Grouped the table by owner.',
      stateHistory: [],
      agentType: 'claude'
    },
    tab: { id: tab.id, worktreeId: WORKTREE, title: 'Claude Chat', customTitle: null },
    agentType: 'claude',
    rowSource: 'live',
    state: 'done',
    startedAt: 0
  } as unknown as DashboardAgentRow
}

export const sidebarAgentRows = defineFixture({
  width: 320,
  store,
  setup: stubNamingFeed,
  render: () => (
    <div className="space-y-1 bg-sidebar p-2">
      {['original', 'fork', 'fork-of-fork', 'unnamed-fork', 'legacy-fork'].map((id, index) => (
        <CompactAgentRow
          key={id}
          agent={agentRow(
            CHATS.find((chat) => chat.id === id)!,
            index
          )}
          now={Date.UTC(2026, 10, 14, 10)}
          onActivate={noop}
          showModel={false}
        />
      ))}
    </div>
  )
})
