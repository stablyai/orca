import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { useGlobalKeybindings } from '@/app-shell/use-global-keybindings'
import { useAppChromeLayout } from '@/app-shell/use-app-chrome-layout'
import { useFloatingWorkspacePanel } from '@/app-shell/use-floating-workspace-panel'
import { useAppStore } from '@/store'
import { useRef } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import {
  makeRepo,
  makeWorktree,
  makeFolderWorkspace,
  makeTerminalTab
} from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeList from '../listing/WorktreeList'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'

function group(id: string, name: string, parentGroupId: string | null = null): ProjectGroup {
  return {
    id,
    name,
    parentGroupId,
    parentPath: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

const repos = [
  { ...makeRepo(), id: 'a', displayName: 'Client', projectGroupId: 'nested' },
  { ...makeRepo(), id: 'b', displayName: 'Services', projectGroupId: 'tools' },
  { ...makeRepo(), id: 'excluded', displayName: 'Filtered project' }
]
const worktrees = Array.from({ length: 18 }, (_, index) =>
  makeWorktree(`a::/preview/work-${index}`, `Workspace ${index + 1}`, {
    repoId: 'a',
    branch: `refs/heads/feature-${index + 1}`,
    isPinned: index === 0
  })
)

function SidebarPreview() {
  useGlobalKeybindings({
    layout: useAppChromeLayout(),
    floatingWorkspace: useFloatingWorkspacePanel()
  })
  const scrollOffsetRef = useRef(0)
  const scrollAnchorRef = useRef<VirtualizedScrollAnchor>(null)
  return (
    <div className="flex h-[640px] w-80 flex-col bg-worktree-sidebar text-worktree-sidebar-foreground">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span>Workspaces</span>
        <SidebarWorkspaceOptionsMenu />
      </div>
      <WorktreeList scrollOffsetRef={scrollOffsetRef} scrollAnchorRef={scrollAnchorRef} />
    </div>
  )
}

async function paint(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

async function openMenu(frame: HTMLElement): Promise<void> {
  frame
    .querySelector('button[aria-label^="Workspace options"]')
    ?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
  await paint()
}

async function selectAction(label: string): Promise<void> {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
    element.textContent?.startsWith(label)
  )
  if (!item) {
    throw new Error(`Missing ${label} action`)
  }
  item.click()
  await paint()
  assertCollapseState(label === 'Collapse all')
}

function assertCollapseState(collapsed: boolean): void {
  const state = useAppStore.getState()
  const expected = collapsed
    ? [
        'lineage:untouched',
        'pinned',
        'project-group:folders',
        'project-group:nested',
        'project-group:product',
        'project-group:tools',
        'project:repo:a',
        'project:repo:b',
        'project:repo:excluded'
      ]
    : ['lineage:untouched', 'project:repo:excluded']
  if (JSON.stringify([...state.collapsedGroups].sort()) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected collapse scope: ${[...state.collapsedGroups].sort().join(', ')}`)
  }
  if (
    state.activeWorktreeId !== 'a::/preview/work-0' ||
    state.tabsByWorktree['a::/preview/work-0']?.[0]?.id !== 'preview-session'
  ) {
    throw new Error('Bulk collapse changed the selected workspace or session')
  }
}

const base = defineFixture({
  width: 660,
  store: {
    repos,
    projectGroups: [
      group('product', 'Product'),
      group('nested', 'Web apps', 'product'),
      group('tools', 'Tools'),
      { ...group('folders', 'Folder workspaces'), parentPath: '/preview/folders' }
    ],
    worktreesByRepo: {
      a: worktrees,
      b: [makeWorktree('b::/preview/service', 'API', { repoId: 'b' })],
      excluded: [makeWorktree('excluded::/preview/hidden', 'Hidden', { repoId: 'excluded' })]
    },
    folderWorkspaces: [makeFolderWorkspace({ projectGroupId: 'folders', name: 'Design notes' })],
    activeWorktreeId: 'a::/preview/work-0',
    tabsByWorktree: {
      'a::/preview/work-0': [
        makeTerminalTab('preview-session', 'a::/preview/work-0', 'Running session')
      ]
    },
    groupBy: 'repo',
    sortBy: 'manual',
    filterRepoIds: ['a', 'b'],
    showSleepingWorkspaces: true,
    collapsedGroups: new Set([
      'project-group:product',
      'project:repo:excluded',
      'lineage:untouched'
    ]),
    keybindings: { 'sidebar.groups.toggleCollapseAll': ['Mod+Shift+E'] },
    worktreeCardProperties: ['branch']
  },
  setup: () => {
    window.api.ui.set = async () => {}
    window.api.folderWorkspaces.getPathStatus = async () => ({
      path: '/preview/folders',
      exists: true
    })
  },
  render: () => (
    <ConfirmationDialogProvider>
      <SidebarPreview />
    </ConfirmationDialogProvider>
  )
})

export const mixed = defineFixture({ ...base, interact: openMenu })
export const collapsed = defineFixture({
  ...base,
  interact: async (frame) => {
    await openMenu(frame)
    await selectAction('Collapse all')
    await openMenu(frame)
  }
})
export const expanded = defineFixture({
  ...base,
  interact: async (frame) => {
    await openMenu(frame)
    await selectAction('Collapse all')
    await openMenu(frame)
    await selectAction('Expand all')
    await openMenu(frame)
  }
})

export const keyboardCollapsed = defineFixture({
  ...base,
  interact: async (frame) => {
    await openMenu(frame)
    await selectAction('Collapse all')
    await openMenu(frame)
    await selectAction('Expand all')
    const isMac = navigator.userAgent.includes('Mac')
    frame.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'E',
        code: 'KeyE',
        metaKey: isMac,
        ctrlKey: !isMac,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    await paint()
    assertCollapseState(true)
    await openMenu(frame)
    if (
      ![...document.querySelectorAll('[role="menuitem"]')].some((item) =>
        item.textContent?.startsWith('Expand all')
      )
    ) {
      throw new Error('Configured shortcut did not collapse the sidebar groups')
    }
  }
})
