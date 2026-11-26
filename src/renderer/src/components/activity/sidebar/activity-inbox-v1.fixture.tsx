// Design preview for docs/activity-center-design.md (Activity inbox v1), drawn with the real app rail
// (including its Activity button and dot), sidebar section headers and the inbox's own rows, section headers
// and empty state. v1 is for the experimental app rail only.
import { DndContext } from '@dnd-kit/core'
import {
  Bell,
  Bot as BotIcon,
  CheckCheck,
  FolderPlus,
  Plus,
  SlidersHorizontal,
  UserPlus
} from 'lucide-react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { AppRail } from '../../app-rail/AppRail'
import { SidebarSectionHeader } from '../../sidebar/SidebarSectionHeader'
import { SidebarActivityBadge } from './sidebar-activity-badge'
import { BotAvatar } from '../../bots/BotAvatar'
import { now, releaseBot, THREADS, triageBot } from './activity-inbox-v1.fixture-data'
import { ActivityInboxEmpty } from '../inbox/ActivityInboxEmpty'
import { AgentInboxRow } from '../inbox/ActivityInbox'
import { ActivityInboxRow, ActivityInboxSectionHeader } from '../inbox/ActivityInboxRow'
import { activityInboxKind } from '../inbox/activity-inbox'
import type { Bot } from '../../../../../shared/bot-types'

function HeaderIcon({ children }: { children: React.ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground">
      {children}
    </Button>
  )
}

/** While Activity is open it owns the sidebar body under its own header; Bots and Projects are hidden. */
function ActivityHeader() {
  return (
    <DndContext>
      <SidebarSectionHeader
        title="Activity"
        sectionId="activity"
        actions={
          <HeaderIcon>
            <CheckCheck className="size-3.5" />
          </HeaderIcon>
        }
      />
    </DndContext>
  )
}

/** The Projects header: with no bell in v1; `todayBadge` draws today's bell for comparison. */
function ProjectsHeader({ todayBadge }: { todayBadge?: React.ReactNode }) {
  return (
    <DndContext>
      <SidebarSectionHeader
        title="Projects"
        sectionId="projects"
        fold={{ collapsed: false, label: 'Collapse Projects', onToggle: () => {} }}
        actions={
          <>
            {todayBadge ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="w-8 text-muted-foreground"
              >
                <span className="relative h-5 w-6 shrink-0">
                  <Bell className="absolute left-0 top-1 size-3" />
                  {todayBadge}
                </span>
              </Button>
            ) : null}
            <HeaderIcon>
              <SlidersHorizontal className="size-3.5" />
            </HeaderIcon>
            <HeaderIcon>
              <FolderPlus className="size-3.5" strokeWidth={2.25} />
            </HeaderIcon>
            <HeaderIcon>
              <Plus className="size-3.5" />
            </HeaderIcon>
          </>
        }
      />
    </DndContext>
  )
}

function BotsHeader() {
  return (
    <DndContext>
      <SidebarSectionHeader
        title="Bots"
        sectionId="bots"
        fold={{ collapsed: true, label: 'Expand Bots', onToggle: () => {} }}
        actions={
          <HeaderIcon>
            <Plus className="size-3.5" />
          </HeaderIcon>
        }
      />
    </DndContext>
  )
}

const noop = (): void => {}

function BotInboxRow({
  bot,
  line,
  request = false
}: {
  bot: Bot
  line: string
  request?: boolean
}) {
  return (
    <ActivityInboxRow
      avatar={<BotAvatar bot={bot} className="size-4 rounded-full" />}
      title={bot.name}
      line={line}
      ask
      contextIcon={request ? <UserPlus className="size-3" /> : <BotIcon className="size-3" />}
      context={request ? 'Access request · Slack' : 'Opens its Needs you'}
      onOpen={noop}
    />
  )
}

/** The inbox as ActivityInbox lays it out: Needs you (agents, then bots and access requests), then New. */
function InboxPreview() {
  const asks = THREADS.filter((thread) => activityInboxKind(thread) === 'ask')
  const outcomes = THREADS.filter(
    (thread) => activityInboxKind(thread) === 'outcome' && thread.unread
  )
  return (
    <div className="px-1.5 pb-2">
      <ActivityInboxSectionHeader label="Needs you" state="waiting" count={asks.length + 3} />
      <ul>
        {asks.map((thread) => (
          <AgentInboxRow key={thread.paneKey} thread={thread} ask onOpen={noop} />
        ))}
        <BotInboxRow bot={triageBot} line="2 tasks need you" />
        <BotInboxRow bot={releaseBot} line="1 task needs you" />
        <BotInboxRow bot={triageBot} line="A teammate asked for access" request />
      </ul>
      <div className="pt-1">
        <ActivityInboxSectionHeader label="New" state="done" count={outcomes.length} />
        <ul>
          {outcomes.map((thread) => (
            <AgentInboxRow key={thread.paneKey} thread={thread} ask={false} onOpen={noop} />
          ))}
        </ul>
      </div>
    </div>
  )
}

function SidebarFrame({ children }: { children: React.ReactNode }) {
  return <div className="bg-worktree-sidebar pb-1 text-foreground">{children}</div>
}

// The real rail, with the rail on. `activity` seeds one agent request so the real dot lights.
function railSetup({ body, activity }: { body: 'workspaces' | 'agents'; activity: boolean }) {
  return (): void => {
    useAppStore.setState((state): Partial<AppState> => ({
      settings: state.settings ? { ...state.settings, experimentalAppRail: true } : state.settings,
      sidebarOpen: true,
      sidebarBody: body,
      activeView: 'terminal' as const,
      migrationUnsupportedByPtyId: activity
        ? {
            'fixture-pty': {
              ptyId: 'fixture-pty',
              paneKey: 'fixture-tab:fixture-leaf',
              reason: 'legacy-numeric-pane-key' as const,
              source: 'local' as const,
              updatedAt: now
            }
          }
        : {}
    }))
  }
}

/** The real rail and the list column beside it, as the app lays them out with the rail on. */
function RailFrame({ height = 720, children }: { height?: number; children?: React.ReactNode }) {
  return (
    <div className="flex bg-worktree-sidebar text-foreground" style={{ height }}>
      {/* The app shell's rail slot: a column, so the rail keeps its own width. */}
      <div className="flex min-h-0 shrink-0 flex-col">
        <AppRail listVisible />
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  )
}

/** Activity open: its rail button is current, and the inbox fills the list column under its own header. */
export const inbox = defineFixture({
  width: 340,
  setup: railSetup({ body: 'agents', activity: true }),
  render: () => (
    <RailFrame height={860}>
      <ActivityHeader />
      <InboxPreview />
    </RailFrame>
  )
})

/** Activity closed: Workspaces is current, the bell carries the unread dot, and Projects has no bell. */
export const closed = defineFixture({
  width: 340,
  setup: railSetup({ body: 'workspaces', activity: true }),
  render: () => (
    <RailFrame height={360}>
      <BotsHeader />
      <ProjectsHeader />
    </RailFrame>
  )
})

/** Nothing new: the bell has no dot. */
export const quiet = defineFixture({
  width: 340,
  setup: railSetup({ body: 'workspaces', activity: false }),
  render: () => (
    <RailFrame height={360}>
      <BotsHeader />
      <ProjectsHeader />
    </RailFrame>
  )
})

/** Today, and still with the rail off: the bell sits in the Projects header and reads 40 when 40 agents work. */
export const bellToday = defineFixture({
  width: 300,
  render: () => (
    <SidebarFrame>
      <ProjectsHeader
        todayBadge={<SidebarActivityBadge counts={{ attention: 0, working: 40 }} />}
      />
    </SidebarFrame>
  )
})

/** Nothing needs you and everything is read. */
export const inboxEmpty = defineFixture({
  width: 340,
  setup: railSetup({ body: 'agents', activity: false }),
  render: () => (
    <RailFrame height={420}>
      <ActivityHeader />
      <ActivityInboxEmpty />
    </RailFrame>
  )
})
