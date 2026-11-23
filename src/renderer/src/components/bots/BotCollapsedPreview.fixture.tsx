import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { publishBotGroups } from '@/lib/bot-group-catalog-snapshot'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { structuredAgentSessionStatusPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { Bot } from '../../../../shared/bot-types'
import { mascotAvatar, type BotMascotId } from '../../../../shared/bot-avatar'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { SidebarBotsSection } from './SidebarBotsSection'
import { setRendererUiLanguage } from '@/i18n/i18n'
import type { SupportedUiLocale } from '../../../../shared/i18n/ui-locale'

function bot(
  id: string,
  name: string,
  mascot: BotMascotId,
  sidebarOrder?: number,
  createdAt = 1
): Bot {
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
    ...(sidebarOrder === undefined ? {} : { sidebarOrder }),
    createdAt,
    updatedAt: 1
  }
}

const BOTS = [
  bot('disk', 'Disk Space', 'D1', 0),
  bot('triage', 'Triage bot', 'K2', 1),
  bot('release', 'Release manager', 'H1', 2),
  bot('docs', 'Docs bot', 'B1', 3),
  bot('builder', 'Builder bot', 'F1', 4),
  bot('notes', 'Notes bot', 'J1', 5),
  bot('lint', 'Lint bot', 'M1', 6)
]

function chat(owner: Bot, state: AgentStatusEntry['state']): AgentStatusEntry {
  return {
    paneKey: structuredAgentSessionStatusPaneKey(`chat-${owner.id}`),
    worktreeId: folderWorkspaceKey(owner.folderWorkspaceId),
    agentType: 'claude',
    prompt: '',
    state,
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    stateHistory: []
  }
}

/** The folded Bots header: one bot needs you, one is working, one is unread, two sit behind "+2". */
export const foldedHeader = defineFixture({
  width: 280,
  store: {
    collapsedGroups: new Set(['bots']),
    folderWorkspaces: BOTS.map((owner) =>
      makeFolderWorkspace({
        id: owner.folderWorkspaceId,
        projectGroupId: 'bots',
        name: owner.name,
        folderPath: `/home/me/.orca/bots/${owner.folder}`,
        isUnread: owner.id === 'docs'
      })
    ),
    agentStatusByPaneKey: acceptedAgentStatuses(
      [chat(BOTS[1]!, 'waiting'), chat(BOTS[2]!, 'working')].map((entry) => [entry.paneKey, entry])
    )
  },
  setup: () => stubBots(BOTS),
  render: () => (
    <ConfirmationDialogProvider>
      <div className="flex flex-col bg-worktree-sidebar pb-2 text-worktree-sidebar-foreground">
        <SidebarBotsSection onOpenBot={() => {}} />
      </div>
    </ConfirmationDialogProvider>
  )
})

function localizedHeader(
  locale: SupportedUiLocale,
  width = 252,
  owners = BOTS,
  readAccessibleLabels = false
) {
  return defineFixture({
    ...foldedHeader,
    width,
    store: {
      ...foldedHeader.store,
      folderWorkspaces: owners.map((owner) =>
        makeFolderWorkspace({
          id: owner.folderWorkspaceId,
          projectGroupId: 'bots',
          name: owner.name,
          folderPath: `/home/me/.orca/bots/${owner.folder}`
        })
      ),
      agentStatusByPaneKey: acceptedAgentStatuses(
        owners.map((owner) => chat(owner, 'waiting')).map((entry) => [entry.paneKey, entry])
      )
    },
    setup: () => stubBots(owners),
    interact: async (frame) => {
      await setRendererUiLanguage(locale)
      if (readAccessibleLabels) {
        const readout = document.createElement('pre')
        readout.className = 'mt-2 whitespace-pre-wrap text-xs'
        readout.textContent = [...frame.querySelectorAll('[aria-label]')]
          .map((element) => element.getAttribute('aria-label'))
          .filter(Boolean)
          .join('\n')
        frame.append(readout)
      }
    }
  })
}

export const chineseHeader = localizedHeader('zh')
export const traditionalChineseHeader = localizedHeader('zh-Hant')
export const germanHeader = localizedHeader('de')
export const spanishHeader = localizedHeader('es')
export const frenchHeader = localizedHeader('fr')
export const japaneseHeader = localizedHeader('ja')
export const koreanHeader = localizedHeader('ko')
export const portugueseHeader = localizedHeader('pt')
export const russianHeader = localizedHeader('ru')
export const turkishHeader = localizedHeader('tr')
export const chineseNormalHeader = localizedHeader('zh', 352)
export const traditionalChineseNormalHeader = localizedHeader('zh-Hant', 352)
export const germanNormalHeader = localizedHeader('de', 352)
export const spanishNormalHeader = localizedHeader('es', 352)
export const frenchNormalHeader = localizedHeader('fr', 352)
export const japaneseNormalHeader = localizedHeader('ja', 352)
export const koreanNormalHeader = localizedHeader('ko', 352)
export const portugueseNormalHeader = localizedHeader('pt', 352)
export const russianNormalHeader = localizedHeader('ru', 352)
export const turkishNormalHeader = localizedHeader('tr', 352)
export const chineseOneBotLabel = localizedHeader('zh', 252, BOTS.slice(0, 1), true)
export const chineseOneHiddenBotLabel = localizedHeader('zh', 352, BOTS.slice(0, 6), true)

const HOMES = (owners: readonly Pick<Bot, 'folderWorkspaceId' | 'name' | 'folder'>[]) =>
  owners.map((owner) =>
    makeFolderWorkspace({
      id: owner.folderWorkspaceId,
      projectGroupId: 'bots',
      name: owner.name,
      folderPath: `/home/me/.orca/bots/${owner.folder}`
    })
  )

export const foldedEmptyHeader = defineFixture({
  ...foldedHeader,
  store: { collapsedGroups: new Set(['bots']) },
  setup: () => stubBots([])
})

export const foldedTwoBotsHeader = defineFixture({
  ...foldedHeader,
  store: { collapsedGroups: new Set(['bots']), folderWorkspaces: HOMES(BOTS.slice(0, 2)) },
  setup: () => stubBots(BOTS.slice(0, 2))
})

// Three bots a drag placed, then "New bot" and a group made after the drag.
const PLACED_AND_NEW = [...BOTS.slice(0, 3), bot('fresh', 'New bot', 'A1', undefined, 2)]
const NEW_GROUP: BotGroup = {
  id: 'crew',
  name: 'Release crew',
  hostId: 'local',
  revision: 1,
  folder: 'crew',
  folderWorkspaceId: 'fw-crew',
  createdAt: 3,
  members: BOTS.slice(1, 3).map((member) => ({ botId: member.id, sessionId: `chat-${member.id}` })),
  replyMode: { kind: 'all' }
}

/** A bot and a group made after the last drag sit on top, as a new workspace does in Manual sort. */
export const newBotOnTop = defineFixture({
  width: 280,
  store: { folderWorkspaces: HOMES([...PLACED_AND_NEW, NEW_GROUP]) },
  setup: () => {
    publishBots(PLACED_AND_NEW, { threadReplies: false, webhooks: undefined, waits: {} })
    publishBotGroups([NEW_GROUP])
  },
  render: () => (
    <ConfirmationDialogProvider>
      <div className="flex flex-col bg-sidebar pb-2 text-sidebar-foreground">
        <SidebarBotsSection onOpenBot={() => {}} />
      </div>
    </ConfirmationDialogProvider>
  )
})

/** The Bots + menu open: its rows are 28px, taller than other menus'. */
export const plusMenu = defineFixture({
  width: 320,
  store: { folderWorkspaces: HOMES(BOTS.slice(0, 3)) },
  setup: () => stubBots(BOTS.slice(0, 3)),
  render: () => (
    <ConfirmationDialogProvider>
      <div className="flex flex-col bg-sidebar pb-2 text-sidebar-foreground">
        <SidebarBotsSection onOpenBot={() => {}} />
      </div>
    </ConfirmationDialogProvider>
  ),
  interact: async () => {
    const trigger = document.querySelector('[aria-label="New bot or group"]')
    trigger?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})

/** The Bots + menu with New bot's submenu opened from the keyboard: Start from scratch leads and takes focus. */
export const plusMenuNewBotSubmenu = defineFixture({
  ...plusMenu,
  width: 520,
  interact: async (frame) => {
    await plusMenu.interact?.(frame)
    const newBot = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'New bot'
    )
    newBot?.focus()
    newBot?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
