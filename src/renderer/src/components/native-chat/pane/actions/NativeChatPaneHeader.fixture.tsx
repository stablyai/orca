import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { stubBots, stubServerBots } from '../../../../component-fixtures/fixture-bots'
import { publishBots, readBots, setBotHostListing } from '@/lib/bot-catalog-snapshot'
import type { Bot } from '../../../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import TabBar from '../../../tab-bar/TabBar'
import { NativeChatPaneHeader } from './NativeChatPaneHeader'

export const splitShortcut = defineFixture({
  width: 420,
  render: () => (
    <div className="relative bg-background p-6 pb-20">
      <NativeChatPaneHeader
        tabId="fixture-chat"
        worktreeId="fixture-workspace"
        groupId="fixture-group"
        nativeChat={{ sessionId: 'fixture-session', agent: undefined }}
        focused
        colorScheme={undefined}
      />
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Split Chat Right"]')?.focus()
  }
})

export const settings = defineFixture({
  ...splitShortcut,
  interact: (frame) => {
    frame
      .querySelector<HTMLButtonElement>('button[aria-label="Chat settings"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
})

const PAIRED_HOST: ExecutionHostId = 'runtime:fixture-server'
const HOME = 'folder:fixture-atlas'
const bot: Bot = {
  id: 'fixture-atlas',
  name: 'Atlas Assistant',
  hostId: 'local',
  folder: 'fixture-atlas',
  folderWorkspaceId: 'fixture-atlas',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'fixture-home',
  createdAt: 1,
  updatedAt: 1
}
const noop = (): void => {}

function homeScene(hostId: ExecutionHostId, width: number) {
  const tab: Tab & { contentType: 'agent-session' } = {
    id: 'fixture-home-tab',
    entityId: 'fixture-home',
    worktreeId: HOME,
    executionHostId: hostId,
    groupId: 'fixture-home-group',
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    label: 'Home',
    customLabel: 'Home',
    color: null,
    sortOrder: 0,
    createdAt: 1,
    isPinned: hostId === 'local'
  }
  return defineFixture({
    width: width + 32,
    store: {
      workspaceSessionReady: true,
      unifiedTabsByWorktree: { [HOME]: [tab] },
      groupsByWorktree: {
        [HOME]: [{ id: tab.groupId, worktreeId: HOME, activeTabId: tab.id, tabOrder: [tab.id] }]
      },
      activeGroupIdByWorktree: { [HOME]: tab.groupId },
      layoutByWorktree: { [HOME]: { type: 'leaf', groupId: tab.groupId } }
    },
    setup: () => {
      setBotHostListing({
        hosts: [
          { hostId: 'local', state: 'live' },
          { hostId: PAIRED_HOST, state: 'live' }
        ],
        updateNeeded: []
      })
      stubBots(hostId === 'local' ? [bot] : [])
      publishBots(
        hostId === PAIRED_HOST ? [bot] : [],
        { threadReplies: false, webhooks: undefined },
        PAIRED_HOST
      )
      stubServerBots({ 'fixture-server': hostId === PAIRED_HOST ? [bot] : [] })
    },
    render: () => (
      <div className="space-y-3" style={{ width }}>
        <div className="text-xs text-muted-foreground">
          Atlas Assistant · {hostId === 'local' ? 'This computer' : 'Paired server'}
        </div>
        <DndContext>
          <div className="@container/tab-strip h-8 bg-card">
            <TabBar
              tabs={[]}
              agentSessionTabs={[tab]}
              activeTabId={tab.id}
              activeTabType="agent-session"
              worktreeId={HOME}
              groupId={tab.groupId}
              expandedPaneByTabId={{}}
              showAgentLaunchItems={false}
              onActivate={noop}
              onActivateAgentSession={noop}
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
        <div className="native-chat-appearance relative h-48 bg-chat-pane ring-1 ring-border">
          <NativeChatPaneHeader
            tabId={tab.id}
            worktreeId={HOME}
            groupId={tab.groupId}
            nativeChat={{ sessionId: tab.entityId, agent: 'claude' }}
            focused
            colorScheme={undefined}
          />
          <div className="flex h-full items-center justify-center text-sm text-chat-foreground-faint">
            Ready for your next message
          </div>
        </div>
        <div data-home-fixture-measurement="" className="text-2xs text-muted-foreground" />
      </div>
    ),
    interact: (frame) => {
      const owner = readBots().find((entry) => entry.id === bot.id)
      if (owner?.hostId !== hostId) {
        throw new Error('Fixture bot host did not match the requested scene')
      }
      const header = frame.querySelector<HTMLElement>('.pane-title-bar')!
      const banner = frame.querySelector<HTMLElement>('[data-bot-home-banner]')
      const style = getComputedStyle(header)
      const containerWidth =
        header.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight)
      if (
        hostId === 'local' &&
        (!banner || getComputedStyle(banner).display !== 'none' || containerWidth > 260)
      ) {
        throw new Error('Narrow Home fixture did not fully hide the banner at the breakpoint')
      }
      if (hostId === PAIRED_HOST && banner) {
        throw new Error('Paired Home fixture unexpectedly rendered a banner')
      }
      frame.querySelector<HTMLElement>('[data-home-fixture-measurement]')!.textContent =
        `Pane ${width}px · header content ${containerWidth}px · banner ${banner ? 'hidden' : 'not rendered'}`
    }
  })
}

export const localHomeHiddenAt260 = homeScene('local', 264)
export const pairedHome = homeScene(PAIRED_HOST, 720)
