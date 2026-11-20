// "Reveal current" from the sidebar toolbar: a bot chat and a bot's worker workspace revealed in the
// Bots section, the button off on a page with no row, and a Projects workspace in front.
import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { requestScrollToCurrentWorkspaceReveal } from '@/lib/workspace/navigation/scroll-to-current-workspace-status'
import { mascotAvatar, type BotMascotId } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { botChatFoldKey, type BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import {
  BOTS_GROUP_KEY,
  getLineageGroupKey,
  PROJECTS_SECTION_GROUP_KEY
} from '../../../../shared/sidebar-list/sections/group-keys'
import type { AppState } from '@/store/types'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { SidebarBotsSection } from '../bots/SidebarBotsSection'
import { SidebarBotsSplit } from './SidebarBotsSplit'
import { ScrollToCurrentWorkspaceToolbarButton } from './worktree-list/navigation/ScrollToCurrentWorkspaceToolbarButton'

function bot(id: string, name: string, mascot: BotMascotId, sidebarOrder: number): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: mascotAvatar(mascot),
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: `chat-${id}`,
    sidebarOrder,
    createdAt: 1,
    updatedAt: 1
  }
}

const BOTS = [
  bot('disk', 'Disk Space', 'D1', 0),
  bot('triage', 'Triage bot', 'K2', 1),
  bot('release', 'Release manager', 'H1', 2),
  bot('docs', 'Docs writer', 'H2', 3),
  bot('builder', 'Builder bot', 'F1', 4)
]
const BUILDER = BOTS[4]!

function chat(chatId: string, title: string, origin: BotChatTreeChat['origin']): BotChatTreeChat {
  return {
    chatId,
    title,
    origin,
    live: 'idle',
    lastActiveAt: Date.now() - 6 * 60_000,
    unread: false,
    closed: false,
    tab: true,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0
  }
}

const WORKERS = ['fix-login-redirect', 'update-install-docs'].map((name) =>
  makeWorktree({
    id: `repo-1::/${name}`,
    repoId: 'repo-1',
    path: `/${name}`,
    displayName: name,
    hostId: 'local'
  })
)
const CHATS = [
  chat('home', 'Home Chat', 'home'),
  chat('chat-login', 'Fix the login redirect', 'slack'),
  chat('chat-docs', 'Refresh the install docs', 'side')
]

/** The bots, with Builder bot's chats read from its host. */
function stubBuilderChats(): void {
  stubBots(BOTS)
  const runtime = window.api.runtime
  const call = runtime.call.bind(runtime)
  Reflect.set(window.api, 'runtime', {
    ...runtime,
    call: async (request: { method: string; params?: { botId?: string } }) =>
      request.method === 'bots.chatTree' && request.params?.botId === BUILDER.id
        ? {
            ok: true,
            result: {
              chats: CHATS,
              workspaceChats: { [WORKERS[0]!.id]: 'chat-login', [WORKERS[1]!.id]: 'chat-docs' }
            }
          }
        : call(request)
  })
}

const HOMES = BOTS.map((owner) =>
  makeFolderWorkspace({
    id: owner.folderWorkspaceId,
    projectGroupId: 'bots',
    name: owner.name,
    folderPath: `/home/me/.orca/bots/${owner.folder}`
  })
)

const BUILDER_KEY = folderWorkspaceKey(BUILDER.folderWorkspaceId)

function frontTab(workspaceKey: string, tab: ReturnType<typeof makeUnifiedTab>): Partial<AppState> {
  return {
    unifiedTabsByWorktree: { [workspaceKey]: [tab] },
    groupsByWorktree: {
      [workspaceKey]: [
        makeTabGroup({ id: 'g', worktreeId: workspaceKey, activeTabId: tab.id, tabOrder: [tab.id] })
      ]
    },
    activeGroupIdByWorktree: { [workspaceKey]: 'g' }
  }
}

const BASE_STORE: Partial<AppState> = {
  sidebarBotsHeight: 300,
  folderWorkspaces: HOMES,
  worktreesByRepo: { 'repo-1': WORKERS },
  hideBotCreatedWorkspaces: true,
  workspaceLineageByChildKey: Object.fromEntries(
    WORKERS.map((worktree) => [
      worktreeWorkspaceKey(worktree.id),
      {
        childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
        parentWorkspaceKey: BUILDER_KEY,
        origin: 'orchestration' as const,
        capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
        createdAt: 1
      }
    ])
  ),
  // Bots folded and Builder bot folded: the reveal has to open the path itself.
  collapsedGroups: new Set([BOTS_GROUP_KEY, getLineageGroupKey(BUILDER_KEY)])
}

function Scene(): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <div
        className="flex flex-col bg-worktree-sidebar text-worktree-sidebar-foreground"
        style={{ height: 520 }}
      >
        <SidebarBotsSplit>
          <SidebarBotsSection onOpenBot={() => {}} />
        </SidebarBotsSplit>
        <div className="flex-1 px-4 py-2 text-xs text-muted-foreground">Projects</div>
        <div className="flex items-center justify-end border-t border-worktree-sidebar-border px-2 py-1.5">
          <ScrollToCurrentWorkspaceToolbarButton />
        </div>
      </div>
    </ConfirmationDialogProvider>
  )
}

function revealButton(frame: HTMLElement): HTMLButtonElement | null {
  return frame.querySelector<HTMLButtonElement>('button[aria-label^="Reveal"]')
}

/** A still can't show a 1.5 s fade, and the capture runs animations to their end; hold the glow at
 *  its first frame, as the app's own reduced-motion rule does. */
function holdRevealGlow(): void {
  const style = document.createElement('style')
  style.textContent =
    '.scroll-to-current-workspace-reveal-highlight::before { animation: none !important; opacity: 1 !important; transform: none !important; }'
  document.head.append(style)
}

/** Clicks Reveal current, then waits for the chat read and a moment of the flash. */
async function clickReveal(frame: HTMLElement): Promise<void> {
  holdRevealGlow()
  const button = revealButton(frame)
  if (button) {
    button.click()
  } else {
    requestScrollToCurrentWorkspaceReveal()
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
}

/** A Builder bot chat in front: Reveal current unfolds Bots and the bot, and flashes that chat. */
export const botChatRevealed = defineFixture({
  width: 300,
  store: {
    ...BASE_STORE,
    activeView: 'terminal',
    activeWorkspaceKey: BUILDER_KEY,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: 'local',
    ...frontTab(
      BUILDER_KEY,
      makeUnifiedTab({
        id: 'tab-login',
        worktreeId: BUILDER_KEY,
        groupId: 'g',
        contentType: 'agent-session',
        entityId: 'chat-login',
        label: 'Fix the login redirect'
      })
    )
  },
  setup: stubBuilderChats,
  render: () => <Scene />,
  interact: clickReveal
})

/** A worker workspace of Builder bot in front, its chat folded: the reveal opens the chat and flashes the line. */
export const workerRevealed = defineFixture({
  width: 300,
  store: {
    ...BASE_STORE,
    activeView: 'terminal',
    activeWorkspaceKey: worktreeWorkspaceKey(WORKERS[0]!.id),
    activeWorktreeId: WORKERS[0]!.id,
    activeWorkspaceExecutionHostId: 'local',
    botChatFolds: { [botChatFoldKey('local', BUILDER.id, 'chat-login')]: 'folded' }
  },
  setup: stubBuilderChats,
  render: () => <Scene />,
  interact: clickReveal
})

/** Settings in front: nothing in the sidebar is current, so the button is off and its tooltip says why. */
export const settingsDisabled = defineFixture({
  width: 300,
  store: {
    ...BASE_STORE,
    collapsedGroups: new Set([PROJECTS_SECTION_GROUP_KEY]),
    activeView: 'settings',
    activeWorkspaceKey: BUILDER_KEY,
    activeWorkspaceExecutionHostId: 'local'
  },
  setup: stubBuilderChats,
  render: () => <Scene />,
  interact: async (frame) => {
    const button = revealButton(frame)
    button?.focus()
    button?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    button?.click()
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
})
