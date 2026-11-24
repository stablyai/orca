import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { stubBots, stubServerBots } from '../../../../component-fixtures/fixture-bots'
import { publishBots, readBots, setBotHostListing } from '@/lib/bot-catalog-snapshot'
import type { Bot } from '../../../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { BOTS_HOME_PIN_RUNTIME_CAPABILITY } from '../../../../../../shared/bot-runtime-capabilities'
import type { RuntimeEnvironmentStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import TabBar from '../../../tab-bar/TabBar'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
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

/** The paired server's verified status; an older one lacks the Home rule. */
function serverStatus(older: boolean): RuntimeEnvironmentStatus {
  const status: RuntimeStatus = {
    runtimeId: 'fixture-server',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    capabilities: older ? [] : [BOTS_HOME_PIN_RUNTIME_CAPABILITY]
  }
  return { status, checkedAt: 1 }
}

const LONG_NAME = 'Atlas Research and Release Coordination Assistant'

type BotChatSceneOptions = {
  side?: boolean
  older?: boolean
  name?: string
  expect?: 'not rendered' | 'hidden' | 'shown'
}

function botChatScene(
  hostId: ExecutionHostId,
  width: number,
  {
    side = false,
    older = false,
    name = bot.name,
    expect = side || older ? 'not rendered' : 'shown'
  }: BotChatSceneOptions = {}
) {
  const ruled = hostId === 'local' || !older
  const sceneBot: Bot = { ...bot, name }
  const label = side ? 'Release notes' : 'Home'
  const tab: Tab & { contentType: 'agent-session' } = {
    id: 'fixture-home-tab',
    entityId: side ? 'fixture-side' : 'fixture-home',
    worktreeId: HOME,
    executionHostId: hostId,
    groupId: 'fixture-home-group',
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    label,
    customLabel: label,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    isPinned: ruled && !side
  }
  const session: NativeChatLiveSession = {
    agent: 'claude',
    sessionId: tab.entityId,
    status: 'ready',
    readPhase: 'ready',
    messages: [
      {
        id: 'release-draft',
        role: 'assistant',
        source: 'transcript',
        timestamp: null,
        blocks: [
          {
            type: 'text',
            text: 'The release notes draft is ready for review. I grouped the fixes by area and kept the wording short so it fits the changelog.'
          }
        ]
      }
    ],
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: async () => 'applied'
  }
  return defineFixture({
    width: width + 32,
    store: {
      workspaceSessionReady: true,
      runtimeStatusByEnvironmentId: new Map([['fixture-server', serverStatus(older)]]),
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
      stubBots(hostId === 'local' ? [sceneBot] : [])
      publishBots(
        hostId === PAIRED_HOST ? [sceneBot] : [],
        { threadReplies: false, webhooks: undefined },
        PAIRED_HOST
      )
      stubServerBots({ 'fixture-server': hostId === PAIRED_HOST ? [sceneBot] : [] })
    },
    render: () => (
      <div style={{ width }}>
        <div className="mb-3 text-xs text-muted-foreground">
          {name} ·{' '}
          {hostId === 'local' ? 'This computer' : older ? 'Older paired server' : 'Paired server'}
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
        <div className="native-chat-appearance relative flex h-56 flex-col bg-chat-pane ring-1 ring-border">
          <NativeChatPaneHeader
            tabId={tab.id}
            worktreeId={HOME}
            groupId={tab.groupId}
            nativeChat={{ sessionId: tab.entityId, agent: 'claude' }}
            focused
            colorScheme={undefined}
          />
          <NativeChatMessageList session={session} isWorking={false} expandSignal={false} />
        </div>
        <div data-home-fixture-measurement="" className="mt-3 text-2xs text-muted-foreground" />
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
      const visibility = !banner
        ? 'not rendered'
        : getComputedStyle(banner).display === 'none'
          ? 'hidden'
          : 'shown'
      if (visibility !== expect) {
        throw new Error(`Expected banner ${expect}, got ${visibility}`)
      }
      const nameElement = banner?.querySelector<HTMLElement>('[data-bot-home-banner-name]')
      if (visibility === 'shown' && !nameElement?.getBoundingClientRect().width) {
        throw new Error('Home fixture did not show the banner with its name')
      }
      frame.querySelector<HTMLElement>('[data-home-fixture-measurement]')!.textContent =
        `Pane ${width}px · header content ${containerWidth}px · banner ${visibility}`
    }
  })
}

export const localHomeHiddenAt260 = botChatScene('local', 264, { expect: 'hidden' })
export const localHomeShortName = botChatScene('local', 720, { name: 'Atlas' })
export const localHomeLongName = botChatScene('local', 720, { name: LONG_NAME })
export const localHomeNarrowLongName = botChatScene('local', 300, { name: LONG_NAME })
export const pairedHome = botChatScene(PAIRED_HOST, 720)
export const pairedHomeOlderServer = botChatScene(PAIRED_HOST, 720, { older: true })

export const localSideChat = botChatScene('local', 720, { side: true })
export const pairedSideChat = botChatScene(PAIRED_HOST, 720, { side: true })

export const localSideChatNarrow = botChatScene('local', 300, { side: true, name: LONG_NAME })
