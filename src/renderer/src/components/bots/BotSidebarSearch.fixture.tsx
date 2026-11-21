import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import type { Bot } from '../../../../shared/bot-types'
import { mascotAvatar, type BotMascotId } from '../../../../shared/bot-avatar'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { SidebarBotsSplit, SidebarProjectsListSlot } from '../sidebar/SidebarBotsSplit'
import { SidebarContentViewport } from '../sidebar/SidebarContentViewport'
import SidebarNav from '../sidebar/chrome/SidebarNav'
import SidebarHeader from '../sidebar/chrome/SidebarHeader'
import SidebarToolbar from '../sidebar/chrome/SidebarToolbar'
import { SidebarBotsSection } from './SidebarBotsSection'
import { setBotPurpose } from './bot-purpose-cache'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { useRef } from 'react'
import type { VirtualizedScrollAnchor } from '@/lib/list-interaction/virtualized-scrolling/useVirtualizedScrollAnchor'
import WorktreeList from '../sidebar/worktree-list/listing/WorktreeList'
import {
  repo,
  worktree
} from '../sidebar/worktree-list/grouping/worktree-list-groups-test-fixtures'
import { worktreeWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { setRendererUiLanguage } from '@/i18n/i18n'
import type { SupportedUiLocale } from '../../../../shared/i18n/ui-locale'

function bot(id: string, name: string, mascot: BotMascotId, order: number, paused = false): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: mascotAvatar(mascot),
    paused,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: `chat-${id}`,
    sidebarOrder: order,
    createdAt: 1,
    updatedAt: 1
  }
}

const BOTS = [
  bot('reviewer', 'Eng - Reviewer', 'D1', 0),
  bot('ux', 'UX Designer', 'K2', 1),
  bot('release', 'Release manager', 'H1', 2),
  bot('triage', 'Triage bot', 'F1', 3),
  bot('docs', 'Docs writer', 'H2', 4),
  bot('sleepy', 'Old reviewer', 'M1', 5, true)
]

const PURPOSES: Record<string, string> = {
  'local/release':
    'Cuts the weekly release, writes the changelog and asks the team to review risky changes',
  'local/docs': 'Keeps the docs in step with what shipped',
  'local/ux': 'Reviews designs and screens against the UX principles'
}

function store(hidePausedBots: boolean) {
  return {
    sidebarBotsHeight: 4000,
    collapsedGroups: new Set<string>(),
    botSidebarView: { sortBy: 'manual' as const, hidePausedBots, hideSleepingWorkers: false },
    folderWorkspaces: BOTS.map((owner) =>
      makeFolderWorkspace({
        id: owner.folderWorkspaceId,
        projectGroupId: 'bots',
        name: owner.name,
        folderPath: `/home/me/.orca/bots/${owner.folder}`
      })
    )
  }
}

function Sidebar(): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <div
        className="flex flex-col bg-worktree-sidebar text-worktree-sidebar-foreground"
        style={{ height: 420 }}
      >
        <SidebarBotsSplit projectsCollapsed>
          <SidebarBotsSection onOpenBot={() => {}} />
        </SidebarBotsSplit>
      </div>
    </ConfirmationDialogProvider>
  )
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

function storeWithChildren() {
  return {
    ...store(false),
    worktreesByRepo: {
      repo: [
        makeWorktree({
          id: 'repo::/worker',
          repoId: 'repo',
          path: '/worker',
          displayName: 'Review follow-up'
        })
      ]
    },
    workspaceLineageByChildKey: {
      'worktree:repo::/worker': {
        childWorkspaceKey: 'worktree:repo::/worker' as const,
        parentWorkspaceKey: 'folder:fw-reviewer' as const,
        origin: 'orchestration' as const,
        capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
        createdAt: 1
      }
    }
  }
}

async function openSearch(frame: HTMLElement): Promise<HTMLInputElement> {
  for (const [key, purpose] of Object.entries(PURPOSES)) {
    setBotPurpose(key, purpose)
  }
  frame.querySelector<HTMLButtonElement>('[data-bot-sidebar-search-toggle]')?.click()
  await settle()
  return frame.querySelector<HTMLInputElement>('input[type="search"]')!
}

function typeInto(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function searching(query: string, options: { hidePaused?: boolean } = {}) {
  return {
    store: store(options.hidePaused ?? false),
    setup: () => stubBots(BOTS),
    render: () => <Sidebar />,
    interact: async (frame: HTMLElement) => {
      const field = await openSearch(frame)
      if (query) {
        typeInto(field, query)
      }
      await settle()
    }
  }
}

/** Header with keyboard focus inside it: Collapse all bots shows after the count. */
export const headerCollapseAll = defineFixture({
  width: 300,
  store: storeWithChildren(),
  setup: () => stubBots(BOTS),
  render: () => <Sidebar />,
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('[data-bots-collapse-toggle] button')?.focus()
    await settle()
  }
})

/** The frame includes 32px padding; the sidebar itself is the app minimum of 220px. */
export const minimumWidthHeader = defineFixture({
  width: 252,
  store: storeWithChildren(),
  setup: () => stubBots(BOTS),
  render: () => <Sidebar />
})

export const noChildren = defineFixture({
  width: 300,
  store: store(false),
  setup: () => stubBots(BOTS),
  render: () => <Sidebar />
})

/** The field just opened: the list shows as it was, with no drag handles. */
export const openEmpty = defineFixture({ width: 300, ...searching('') })

function localizedSearch(locale: SupportedUiLocale, width = 252) {
  return defineFixture({
    width,
    ...searching(''),
    interact: async (frame) => {
      await setRendererUiLanguage(locale)
      await openSearch(frame)
    }
  })
}

export const chineseMinimumWidthSearch = localizedSearch('zh')
export const traditionalChineseSearch = localizedSearch('zh-Hant')
export const germanSearch = localizedSearch('de')
export const spanishSearch = localizedSearch('es')
export const frenchSearch = localizedSearch('fr')
export const japaneseSearch = localizedSearch('ja')
export const koreanSearch = localizedSearch('ko')
export const portugueseSearch = localizedSearch('pt')
export const russianSearch = localizedSearch('ru')
export const turkishSearch = localizedSearch('tr')
export const chineseNormalSearch = localizedSearch('zh', 352)
export const traditionalChineseNormalSearch = localizedSearch('zh-Hant', 352)
export const germanNormalSearch = localizedSearch('de', 352)
export const spanishNormalSearch = localizedSearch('es', 352)
export const frenchNormalSearch = localizedSearch('fr', 352)
export const japaneseNormalSearch = localizedSearch('ja', 352)
export const koreanNormalSearch = localizedSearch('ko', 352)
export const portugueseNormalSearch = localizedSearch('pt', 352)
export const russianNormalSearch = localizedSearch('ru', 352)
export const turkishNormalSearch = localizedSearch('tr', 352)

/** Name matches, then a purpose match with its snippet. */
export const results = defineFixture({ width: 300, ...searching('review') })

/** A paused bot hidden by Hide paused bots matches. */
export const pausedHidden = defineFixture({ width: 300, ...searching('old', { hidePaused: true }) })

export const noMatches = defineFixture({ width: 300, ...searching('zzz') })

/** The narrow sidebar. */
export const narrow = defineFixture({ width: 180, ...searching('release') })

const MANY_BOTS: Bot[] = Array.from({ length: 18 }, (_, index) =>
  bot(`bot-${index}`, index === 0 ? "Carol's CoS" : `Bot ${index + 1}`, 'D1', index)
)

/** Eighteen bots in the height-capped split under a Projects list: the field takes its own row above them. */
/** The first bot's chats, so its row unfolds into Home Chat and Codex Chat as in the sidebar. */
function stubFirstBotChats(): void {
  const chat = (chatId: string, title: string, origin: 'home' | 'side') => ({
    chatId,
    title,
    origin,
    live: 'idle' as const,
    lastActiveAt: Date.now() - 3_600_000,
    unread: false,
    closed: false,
    tab: true,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0
  })
  const runtime = window.api.runtime
  const call = runtime.call.bind(runtime)
  Reflect.set(window.api, 'runtime', {
    ...runtime,
    call: async (request: { method: string; params?: { botId?: string } }) =>
      request.method === 'bots.chatTree'
        ? {
            ok: true,
            result: {
              chats:
                request.params?.botId === MANY_BOTS[0].id
                  ? [chat('home', 'Home Chat', 'home'), chat('codex', 'Codex Chat', 'side')]
                  : [],
              workspaceChats: {}
            }
          }
        : call(request)
  })
}

function capped(
  query: string,
  options: {
    height?: number
    scrolled?: boolean
    chats?: boolean
    folded?: boolean
    windowHeight?: number
    realProjects?: boolean
    /** Six bots instead of eighteen: the list is shorter than the split's cap. */
    few?: boolean
  } = {}
) {
  const owners = options.few ? BOTS : MANY_BOTS
  return {
    store: {
      ...store(false),
      sidebarBotsHeight: options.height ?? null,
      collapsedGroups: new Set(options.folded ? ['projects-section'] : []),
      ...(options.realProjects
        ? {
            repos: [repo],
            worktreesByRepo: { [repo.id]: [{ ...worktree, hostId: 'local' as const }] },
            activeWorktreeId: worktree.id,
            activeWorkspaceKey: worktreeWorkspaceKey(worktree.id),
            activeWorkspaceExecutionHostId: 'local' as const
          }
        : {}),
      folderWorkspaces: owners.map((owner) =>
        makeFolderWorkspace({
          id: owner.folderWorkspaceId,
          projectGroupId: 'bots',
          name: owner.name,
          folderPath: `/home/me/.orca/bots/${owner.folder}`
        })
      )
    },
    setup: () => {
      stubBots(owners)
      if (options.chats) {
        stubFirstBotChats()
      }
    },
    render: () => (
      <ConfirmationDialogProvider>
        <div
          data-sidebar-window=""
          className="flex flex-col overflow-hidden bg-worktree-sidebar text-worktree-sidebar-foreground"
          style={{ height: options.windowHeight ?? 700 }}
        >
          <div className="h-9 shrink-0 px-4 py-2 text-xs">Orca</div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <SidebarContentViewport>
              <SidebarNav />
              <SidebarBotsSplit projectsCollapsed={options.folded}>
                <SidebarBotsSection onOpenBot={() => {}} />
              </SidebarBotsSplit>
              <SidebarHeader collapsible onWorkspaceBoardMenuOpenChange={() => {}} />
              <SidebarProjectsListSlot botsShown collapsed={options.folded}>
                {options.realProjects ? (
                  <ProjectWorkspaces />
                ) : (
                  <div className="worktree-sidebar-scrollbar min-h-0 flex-1 overflow-y-auto px-4 text-xs">
                    {Array.from({ length: 18 }, (_, index) => (
                      <div key={index} className="py-2">
                        Project {index + 1}
                      </div>
                    ))}
                  </div>
                )}
              </SidebarProjectsListSlot>
            </SidebarContentViewport>
            <SidebarToolbar workspaceBoardOpen={false} onWorkspaceBoardToggle={() => {}} />
          </div>
          <div className="h-6 shrink-0 border-t border-border" />
        </div>
      </ConfirmationDialogProvider>
    ),
    interact: async (frame: HTMLElement) => {
      if (options.scrolled) {
        const list = frame.querySelector<HTMLElement>('[data-bot-sidebar-list]')
        list?.scrollTo({ top: list.scrollHeight })
        await settle()
      }
      if (options.chats) {
        await settle()
      }
      for (const owner of owners.filter((_, index) => index % 2 === 1)) {
        setBotPurpose(`local/${owner.id}`, 'Keeps bot projects in step with the team')
      }
      const field = await openSearch(frame)
      if (query) {
        typeInto(field, query)
      }
      await settle()
    }
  }
}

function ProjectWorkspaces(): React.JSX.Element {
  const scrollOffsetRef = useRef(0)
  const scrollAnchorRef = useRef<VirtualizedScrollAnchor>(null)
  return <WorktreeList scrollOffsetRef={scrollOffsetRef} scrollAnchorRef={scrollAnchorRef} />
}

/** Opened over a long list that overflows the split: the list starts under the field, not behind it. */
export const longListOpenEmpty = defineFixture({ width: 300, ...capped('') })

/** A saved Bots height, opened with nothing typed: typing must keep the section at this height. */
export const savedHeightOpenEmpty = defineFixture({ width: 300, ...capped('', { height: 320 }) })

/** Six bots, shorter than the saved cap: the section holds the height the field opened with. */
export const shortListOpenEmpty = defineFixture({
  width: 300,
  ...capped('', { height: 480, few: true, windowHeight: 900 })
})

/** Many results in the capped split: they scroll under the field. */
export const longListResults = defineFixture({ width: 300, ...capped('bot') })

/** Opened with the list scrolled to its end: the field sits above the scrolled rows, not on them. */
export const longListScrolled = defineFixture({ width: 300, ...capped('', { scrolled: true }) })

/** Bots dragged to its 80px minimum: the header and field keep their rows. */
export const longListMinimumHeight = defineFixture({ width: 300, ...capped('', { height: 80 }) })

/** Typed with Bots at its minimum height. */
export const longListMinimumHeightResults = defineFixture({
  width: 300,
  ...capped('bot', { height: 80 })
})

/** The first bot unfolded into its chats, as in the report: the field sits above its two-line row. */
export const longListWithChats = defineFixture({ width: 300, ...capped('', { chats: true }) })

export const longListNoMatches = defineFixture({ width: 300, ...capped('zzz') })

/** Projects folded: all eighteen bots still scroll below the fixed field. */
export const longListProjectsFolded = defineFixture({
  width: 300,
  ...capped('bot', { folded: true })
})

/** Minimum native window height, including a conservative 14px native titlebar allowance. */
export const longListSmallestWindow = defineFixture({
  width: 252,
  ...capped('bot', { height: 80, windowHeight: 386 })
})

/** The real Projects list and toolbar exercise the public active-workspace reveal. */
export const longListBeforeProjectReveal = defineFixture({
  width: 300,
  ...capped('bot', { height: 80, windowHeight: 386, realProjects: true })
})
