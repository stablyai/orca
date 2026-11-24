import { stubBots } from '../../../component-fixtures/fixture-bots'
import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ChatWorkspaceSection } from './ChatWorkspaceSection'
import { makeRepo, makeWorktree } from '../../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeList from '../worktree-list/listing/WorktreeList'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { SidebarHeaderActions } from '../chrome/sidebar-header-actions'

export const empty = defineFixture({
  width: 320,
  setup: () => stubBots([]),
  store: { repos: [] },
  render: () => (
    <DndContext>
      <div className="bg-worktree-sidebar pb-4">
        <ChatWorkspaceSection />
        <div className="mt-2 flex h-8 items-center justify-between px-4">
          <span className="text-xs font-semibold text-muted-foreground/80">Projects</span>
          <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={() => {}} />
        </div>
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
        <div className="flex h-[520px] flex-col bg-worktree-sidebar text-worktree-sidebar-foreground">
          <ChatWorkspaceSection />
          <div className="mt-2 flex h-8 shrink-0 items-center justify-between px-4">
            <span className="text-xs font-semibold text-muted-foreground/80">Projects</span>
            <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={() => {}} />
          </div>
          <WorktreeList scrollOffsetRef={offset} scrollAnchorRef={anchor} />
        </div>
      </ConfirmationDialogProvider>
    </DndContext>
  )
})

export const before = defineFixture({
  ...populated,
  store: { ...populated.store, repos: [project], worktreesByRepo: { 'repo-1': [projectRoot] } },
  render: () => (
    <DndContext>
      <ConfirmationDialogProvider>
        <div className="flex h-[520px] flex-col bg-worktree-sidebar text-worktree-sidebar-foreground">
          <div className="mt-2 flex h-8 shrink-0 items-center justify-between px-4">
            <span className="text-xs font-semibold text-muted-foreground/80">Projects</span>
            <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={() => {}} />
          </div>
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
