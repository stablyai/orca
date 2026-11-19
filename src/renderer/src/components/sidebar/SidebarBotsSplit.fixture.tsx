import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import type { Bot } from '../../../../shared/bot-types'
import { mascotAvatar, type BotMascotId } from '../../../../shared/bot-avatar'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { SidebarBotsSection } from '../bots/SidebarBotsSection'
import { SidebarBotsSplit, SidebarProjectsListSlot } from './SidebarBotsSplit'
import { SidebarContentViewport } from './SidebarContentViewport'
import SidebarHeader from './chrome/SidebarHeader'
import { BOTS_GROUP_KEY } from '../../../../shared/sidebar-list/sections/group-keys'

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
  bot('builder', 'Builder bot', 'F1', 3)
]

// The Projects rows' scroll container, so bot rows line up against it.
function ProjectsStandIn(): React.JSX.Element {
  return (
    <div className="worktree-sidebar-scrollbar h-full overflow-y-auto overflow-x-hidden pl-1 scrollbar-sleek">
      {Array.from({ length: 12 }, (_, index) => (
        <div
          key={index}
          className="my-0.5 rounded-md bg-worktree-sidebar-accent px-2 py-1.5 text-xs"
        >
          Project workspace {index + 1}
        </div>
      ))}
    </div>
  )
}

// The sidebar's own viewport and Projects header, so the seam's spacing and reach match the app.
function SidebarFrame(): React.JSX.Element {
  return (
    <div
      className="flex flex-col bg-worktree-sidebar text-worktree-sidebar-foreground"
      style={{ height: 520 }}
    >
      <SidebarContentViewport>
        <SidebarBotsSplit>
          <SidebarBotsSection onOpenBot={() => {}} />
        </SidebarBotsSplit>
        <SidebarHeader collapsible onWorkspaceBoardMenuOpenChange={() => {}} />
        <SidebarProjectsListSlot botsShown>
          <ProjectsStandIn />
        </SidebarProjectsListSlot>
      </SidebarContentViewport>
    </div>
  )
}

function splitAt(sidebarBotsHeight: number | null, { folded = false } = {}) {
  return defineFixture({
    width: 300,
    store: {
      sidebarBotsHeight,
      ...(folded ? { collapsedGroups: new Set([BOTS_GROUP_KEY]) } : {}),
      // An active row paints its full width.
      activeWorkspaceKey: folderWorkspaceKey('fw-builder'),
      folderWorkspaces: BOTS.map((owner) =>
        makeFolderWorkspace({
          id: owner.folderWorkspaceId,
          projectGroupId: 'bots',
          name: owner.name,
          folderPath: `/home/me/.orca/bots/${owner.folder}`
        })
      )
    },
    setup: () => stubBots(BOTS),
    render: () => (
      <ConfirmationDialogProvider>
        <SidebarFrame />
      </ConfirmationDialogProvider>
    )
  })
}

/** Bots dragged to its minimum, a middle height, and its maximum: rows keep one width throughout. */
export const draggedMin = splitAt(80)
export const draggedMid = splitAt(170)
export const draggedMax = splitAt(4000)
/** Folded: the header row is just the title and the faces, without its controls. */
export const folded = splitAt(170, { folded: true })

const MANY_BOTS = [
  ...BOTS,
  bot('nudge', 'Nudge', 'M1', 4),
  bot('perf', 'Perf manager', 'N1', 5),
  bot('docs', 'Docs writer', 'H2', 6),
  bot('deps', 'Dependency bot', 'O1', 7)
]

const BUILDER_WORKSPACES = ['fix-flaky-test', 'update-install-docs', 'perf-sweep'].map((name) =>
  makeWorktree({ id: `repo-1::/${name}`, repoId: 'repo-1', path: `/${name}`, displayName: name })
)

/** More bots than the split fits, the first with workspaces its workers made. */
export const overflowWithWorkspaces = defineFixture({
  width: 300,
  store: {
    sidebarBotsHeight: 240,
    folderWorkspaces: MANY_BOTS.map((owner) =>
      makeFolderWorkspace({
        id: owner.folderWorkspaceId,
        projectGroupId: 'bots',
        name: owner.name,
        folderPath: `/home/me/.orca/bots/${owner.folder}`
      })
    ),
    worktreesByRepo: { 'repo-1': BUILDER_WORKSPACES },
    workspaceLineageByChildKey: Object.fromEntries(
      BUILDER_WORKSPACES.map((worktree) => [
        worktreeWorkspaceKey(worktree.id),
        {
          childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
          parentWorkspaceKey: folderWorkspaceKey('fw-disk'),
          origin: 'orchestration' as const,
          capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
          createdAt: 1
        }
      ])
    )
  },
  setup: () => stubBots(MANY_BOTS),
  render: () => (
    <ConfirmationDialogProvider>
      <SidebarFrame />
    </ConfirmationDialogProvider>
  )
})
