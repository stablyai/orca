import { useState } from 'react'
import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import type { Bot } from '../../../../shared/bot-types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import TabBar from './TabBar'

const bot: Bot = {
  id: 'release-helper',
  name: 'Release helper',
  hostId: 'local',
  folder: 'release-helper',
  folderWorkspaceId: 'fw-release-helper',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'release-helper-chat',
  createdAt: 0,
  updatedAt: 0
}
const WORKSPACE_ID = folderWorkspaceKey(bot.folderWorkspaceId)
const GROUP_ID = 'bot-home-group'
const SIDE_TITLES = [
  'Draft the release notes',
  'Triage the flaky upload test',
  'Check the nightly build',
  'Answer the docs question'
]
const noop = (): void => {}

function chatTab(
  id: string,
  entityId: string,
  label: string,
  index: number,
  color: string | null = null
): Tab & { contentType: 'agent-session' } {
  return {
    id,
    entityId,
    groupId: GROUP_ID,
    worktreeId: WORKSPACE_ID,
    executionHostId: 'local',
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    label,
    customLabel: null,
    color,
    sortOrder: index,
    createdAt: index,
    isPinned: index === 0
  }
}

function BotHomeTabsFixture({
  sideChats,
  paneHeader = false,
  homeColor = null,
  homeIndex = 0
}: {
  sideChats: number
  /** Where the stored order holds Home, as after a restore or a new tab landed ahead of it. */
  homeIndex?: number
  /** Mirrors TabGroupPanel's header: drag handle, quick commands and pane actions share the strip's width. */
  paneHeader?: boolean
  homeColor?: string | null
}): React.JSX.Element {
  const tabs = [
    chatTab('home-tab', bot.chatSessionId!, 'Home', 0, homeColor),
    ...Array.from({ length: sideChats }, (_, index) =>
      chatTab(
        `side-${index}`,
        `side-chat-${index}`,
        SIDE_TITLES[index % SIDE_TITLES.length],
        index + 1
      )
    )
  ]
  const order = tabs.slice(1).map((tab) => tab.id)
  order.splice(homeIndex, 0, tabs[0]!.id)
  const [activeTabId, setActiveTabId] = useState(tabs.at(-1)!.id)
  const tabBar = (
    <TabBar
      tabs={[]}
      agentSessionTabs={tabs}
      tabBarOrder={order}
      activeTabId={activeTabId}
      activeTabType="agent-session"
      worktreeId={WORKSPACE_ID}
      groupId={GROUP_ID}
      // A focused group, as after a click into it: the +N list closes in an unfocused one.
      isGroupFocused
      expandedPaneByTabId={{}}
      showAgentLaunchItems={false}
      onActivate={setActiveTabId}
      onActivateAgentSession={setActiveTabId}
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
  )
  return (
    <DndContext>
      {paneHeader ? (
        <div data-fixture-pane-header="" className="flex h-8 items-stretch bg-card pr-1">
          <div className="@container/tab-strip group/tab-strip-row flex min-w-0 flex-1 items-stretch">
            <div className="h-full min-w-10 flex-1">{tabBar}</div>
            <div className="w-10 min-w-0 @max-[203px]/tab-strip:hidden group-has-[[data-pinned-home-with-strip]]/tab-strip-row:@max-[243px]/tab-strip:hidden" />
            <div className="flex min-w-0 items-center gap-0.5 overflow-hidden pr-0.5 pl-1.5">
              <div className="h-6 w-[47px] shrink-0 rounded-md bg-muted @max-[163px]/tab-strip:hidden group-has-[[data-pinned-home-with-strip]]/tab-strip-row:@max-[203px]/tab-strip:hidden" />
              <div className="size-7 shrink-0 rounded-md bg-muted @max-[114px]/tab-strip:hidden group-has-[[data-pinned-home-with-strip]]/tab-strip-row:@max-[154px]/tab-strip:hidden" />
            </div>
          </div>
        </div>
      ) : (
        <div className="@container/tab-strip h-8 bg-card">{tabBar}</div>
      )}
    </DndContext>
  )
}

const setup = (): void => {
  publishBots([bot], { threadReplies: false, webhooks: false })
}

export const homeOnly = defineFixture({
  width: 620,
  store: { workspaceSessionReady: true },
  setup,
  render: () => <BotHomeTabsFixture sideChats={0} />
})

export const homeWithSideChats = defineFixture({
  width: 900,
  store: { workspaceSessionReady: true },
  setup,
  render: () => <BotHomeTabsFixture sideChats={2} />
})

// Side chats overflow the strip: they condense behind +N while Home stays whole at the left edge.
export const homeOverflowing = defineFixture({
  width: 620,
  store: { workspaceSessionReady: true },
  setup,
  render: () => <BotHomeTabsFixture sideChats={12} />
})

// A narrow split: the strip folds to its +N chip, then Home narrows to its icons.
export const homeNarrowSplit = defineFixture({
  width: 160,
  store: { workspaceSessionReady: true },
  setup,
  render: () => <BotHomeTabsFixture sideChats={12} />
})

// Inside a pane header whose actions share the width; resize [data-fixture-pane-header] to probe narrow splits.
export const homeInPaneHeader = defineFixture({
  width: 620,
  store: { workspaceSessionReady: true },
  setup,
  render: () => <BotHomeTabsFixture sideChats={12} paneHeader />
})

// Home with a tab color: its dot must hide before it would clip in a narrow header.
export const homeColoredInPaneHeader = defineFixture({
  width: 620,
  store: { workspaceSessionReady: true },
  setup,
  render: () => <BotHomeTabsFixture sideChats={12} paneHeader homeColor="#e11d48" />
})

// Past the windowing threshold: the strip mounts runs of side chats around gaps while Home stays pinned.
export const homeWindowed = defineFixture({
  width: 620,
  store: { workspaceSessionReady: true },
  setup,
  render: () => <BotHomeTabsFixture sideChats={120} />
})

// Other tabs ahead of Home in the stored order (a restored layout, a newly opened tab): Home still leads.
export const homeBehindOtherTabs = defineFixture({
  width: 620,
  store: { workspaceSessionReady: true },
  setup,
  render: () => <BotHomeTabsFixture sideChats={12} homeIndex={2} />
})
