import { stubBots } from '../../../component-fixtures/fixture-bots'
import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ChatWorkspaceSection } from './ChatWorkspaceSection'
import { makeRepo, makeWorktree } from '../../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeList from '../worktree-list/listing/WorktreeList'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import SidebarHeader from '../chrome/SidebarHeader'
import { SidebarSectionHeader } from '../SidebarSectionHeader'
import { SidebarProjectsListSlot } from '../SidebarBotsSplit'
import { useAppStore } from '@/store'
import { PROJECTS_SECTION_GROUP_KEY } from '../../../../../shared/sidebar-list/sections/group-keys'

function ProjectsHeader() {
  return <SidebarHeader collapsible reorderable={false} onWorkspaceBoardMenuOpenChange={() => {}} />
}

function PopulatedSidebar() {
  const collapsed = useAppStore((state) => state.collapsedGroups.has(PROJECTS_SECTION_GROUP_KEY))
  return (
    <div className="flex h-[520px] flex-col bg-worktree-sidebar text-worktree-sidebar-foreground">
      <ProjectsHeader />
      <SidebarProjectsListSlot botsShown collapsed={collapsed}>
        <WorktreeList scrollOffsetRef={offset} scrollAnchorRef={anchor} />
      </SidebarProjectsListSlot>
      <ChatWorkspaceSection />
      <SidebarSectionHeader
        title="Bots"
        sectionId="bots"
        actions={null}
        fold={{ collapsed: true, label: 'Expand Bots', onToggle: () => {} }}
      />
    </div>
  )
}

export const empty = defineFixture({
  width: 320,
  setup: () => stubBots([]),
  store: { repos: [] },
  render: () => (
    <DndContext>
      <div className="bg-worktree-sidebar pb-4">
        <ProjectsHeader />
        <ChatWorkspaceSection />
      </div>
    </DndContext>
  )
})

export const hostMenu = defineFixture({
  ...empty,
  width: 420,
  store: {
    ...empty.store,
    runtimeEnvironments: [
      {
        id: 'paired-devbox',
        name: 'Devbox',
        source: 'manual',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: 'devbox-fixture',
        pairedDeviceId: 'fixture-device',
        pairingRevision: 1,
        preferredEndpointId: 'default',
        endpoints: []
      }
    ],
    runtimeStatusByEnvironmentId: new Map([
      [
        'paired-devbox',
        {
          checkedAt: 1,
          status: null,
          snapshot: {
            environmentId: 'paired-devbox',
            pairingRevision: 1,
            sequence: 1,
            checkedAt: 1,
            status: null,
            verification: 'verified',
            transport: 'ready'
          }
        }
      ]
    ])
  },
  interact: async (frame) => {
    frame
      .querySelector<HTMLButtonElement>('button[aria-label="New chat workspace"]')
      ?.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerType: 'mouse'
        })
      )
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
})

const chat = {
  ...makeRepo(),
  id: 'chat',
  path: '/home/me/.orca/chats/draft',
  displayName: 'Plan a release',
  kind: 'folder' as const,
  chatWorkspace: { initialName: 'New project-20261124', autoName: false }
}
const project = { ...makeRepo(), displayName: 'Orca' }
const chatRoot = makeWorktree(`chat::${chat.path}`, 'Plan a release', {
  repoId: chat.id,
  path: chat.path,
  branch: '',
  isMainWorktree: true,
  hostId: 'local'
})
const projectRoot = makeWorktree(`repo-1::${project.path}`, 'main', {
  path: project.path,
  branch: 'main',
  isMainWorktree: true,
  hostId: 'local'
})
const offset = { current: 0 }
const anchor = { current: null }

export const populated = defineFixture({
  width: 320,
  setup: () => stubBots([]),
  store: {
    repos: [chat, project],
    worktreesByRepo: { chat: [chatRoot], 'repo-1': [projectRoot] },
    groupBy: 'repo',
    showSleepingWorkspaces: true,
    hideDefaultBranchWorkspace: false
  },
  render: () => (
    <DndContext>
      <ConfirmationDialogProvider>
        <PopulatedSidebar />
      </ConfirmationDialogProvider>
    </DndContext>
  )
})

export const collapsed = defineFixture({
  ...populated,
  store: {
    ...populated.store,
    collapsedGroups: new Set([PROJECTS_SECTION_GROUP_KEY, 'sidebar:chats'])
  }
})

export const projectCollapsed = defineFixture({
  ...populated,
  store: { ...populated.store, collapsedGroups: new Set([PROJECTS_SECTION_GROUP_KEY]) },
  interact: async (frame) => {
    const header = frame.querySelector<HTMLElement>(
      '[data-sidebar-workspace-section="chats"] [aria-expanded="true"]'
    )
    header?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})

export const before = defineFixture({
  ...populated,
  store: { ...populated.store, repos: [project], worktreesByRepo: { 'repo-1': [projectRoot] } },
  render: () => (
    <DndContext>
      <ConfirmationDialogProvider>
        <div className="flex h-[520px] flex-col bg-worktree-sidebar text-worktree-sidebar-foreground">
          <ProjectsHeader />
          <WorktreeList scrollOffsetRef={offset} scrollAnchorRef={anchor} />
        </div>
      </ConfirmationDialogProvider>
    </DndContext>
  )
})

export const hostSubmenu = defineFixture({
  ...hostMenu,
  width: 720,
  interact: async (frame) => {
    await hostMenu.interact?.(frame)
    document
      .querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
      ?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    await new Promise((resolve) => setTimeout(resolve, 240))
  }
})
