import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { CompactAgentRow } from './worktree-card-compact-agent-row'
import DashboardAgentRow from '../../../dashboard/DashboardAgentRow'
import type { DashboardAgentRow as DashboardAgentRowData } from '../../../dashboard/rows/dashboard-agent-row'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'

const WORKTREE = 'repo-1::/repos/orca'
// A stand-in picture: Orca ships no badge art, the program that pins a badge sends its own.
const ICON = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#e87d0d"/><circle cx="8" cy="8" r="3" fill="#265787"/></svg>'
)}`

const CHATS = [
  {
    id: 'linked',
    name: 'Wall reinforcement review',
    badge: { label: 'Linked to Blender', icon: ICON }
  },
  { id: 'plain', name: 'Release notes', badge: null }
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
            forkedFrom: null,
            ...(chat.badge ? { badge: chat.badge } : {})
          }))
        },
        _meta: { runtimeId: 'fixture' }
      })
    )
    return { unsubscribe: () => {}, sendBinary: () => {} }
  }
}

function chatTab(id: string): Tab & { contentType: 'agent-session' } {
  return {
    id: `tab-${id}`,
    entityId: id,
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

function agentRow(id: string, index: number): DashboardAgentRowData {
  const tab = chatTab(id)
  const at = Date.UTC(2026, 10, 27, 9, index)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only these fields.
  return {
    paneKey: `${tab.id}:chat`,
    entry: {
      state: 'done',
      prompt: '',
      updatedAt: at,
      stateStartedAt: at,
      lastAssistantMessage: 'Moved the links to 150 mm.',
      stateHistory: [],
      agentType: 'claude'
    },
    tab: { id: tab.id, worktreeId: WORKTREE, title: 'Claude Chat', customTitle: null },
    agentType: 'claude',
    rowSource: 'live',
    state: 'done',
    startedAt: 0
  } as unknown as DashboardAgentRowData
}

const store = { unifiedTabsByWorktree: { [WORKTREE]: CHATS.map((chat) => chatTab(chat.id)) } }
const noop = (): void => {}
const now = Date.UTC(2026, 10, 27, 10)

export const compactRows = defineFixture({
  width: 320,
  store,
  setup: stubNamingFeed,
  render: () => (
    <div className="space-y-1 bg-sidebar p-2">
      {CHATS.map((chat, index) => (
        <CompactAgentRow
          key={chat.id}
          agent={agentRow(chat.id, index)}
          now={now}
          onActivate={noop}
          showModel={false}
        />
      ))}
    </div>
  )
})

export const fullRows = defineFixture({
  width: 320,
  store,
  setup: stubNamingFeed,
  render: () => (
    <div className="space-y-1 bg-sidebar p-2">
      {CHATS.map((chat, index) => (
        <DashboardAgentRow
          key={chat.id}
          agent={agentRow(chat.id, index)}
          now={now}
          onActivate={noop}
          onDismiss={noop}
        />
      ))}
    </div>
  )
})
