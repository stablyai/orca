// @vitest-environment happy-dom
// "Reveal current" while a bot's page or a bot's worker workspace is in front: the Projects list must
// not ask to adjust filters, change them, open repo groups, or leave a reveal pending (owner's bug).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStore } from 'zustand'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createUIStore } from '@/store/slices/ui/ui-slice-test-harness'
import type { AppState } from '@/store/types'
import { requestScrollToCurrentWorkspaceReveal } from '@/lib/workspace/navigation/scroll-to-current-workspace-status'
import type { Bot } from '../../../../../../shared/bot-types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceHostIdentity } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { useSidebarRevealRequests } from './use-reveal-requests'
import { usePendingSidebarReveal } from './use-pending-reveal'
import { repo, worktree as baseWorktree } from '../grouping/worktree-list-groups-test-fixtures'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { workspaceKeyOfRow } from '../../../../../../shared/workspace/identity/workspace-scope'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { PROJECTS_SECTION_GROUP_KEY } from '../../../../../../shared/sidebar-list/sections/group-keys'

let store: ReturnType<typeof createUIStore>
vi.mock('@/store', async () => {
  const { useStore } = await import('zustand')
  return {
    useAppStore: Object.assign((selector: (s: AppState) => unknown) => useStore(store, selector), {
      getState: () => store.getState(),
      subscribe: (listener: () => void) => store.subscribe(listener)
    })
  }
})
const confirm = vi.hoisted(() => vi.fn())
vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirm
}))
const bots = vi.hoisted(() => {
  const list: Bot[] = []
  return { list }
})
vi.mock('@/lib/bot-catalog-snapshot', () => ({
  readBots: () => bots.list,
  readBotHostIds: () => ['local'],
  readBotHostState: () => 'live',
  subscribeToBotChanges: () => () => {}
}))
vi.mock('@/lib/bot-group-catalog-snapshot', () => ({
  readBotGroups: () => [],
  subscribeToBotGroupChanges: () => () => {}
}))
vi.mock('@/lib/bot-host-kept-homes', () => ({
  withKeptBotHomes: (folders: readonly FolderWorkspace[]) => folders
}))
const children = vi.hoisted(() => ({ map: new Map<string, Worktree[]>() }))
vi.mock('@/store/slices/worktrees/metadata/cross-store-lineage-parents', () => ({
  selectSidebarChildrenByParentIdentity: () => children.map
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const home = makeFolderWorkspace({ id: 'home-1', projectGroupId: 'bots-group', name: 'Scout' })
const bot: Bot = {
  id: 'bot-1',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'home-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}
const worker: Worktree = { ...baseWorktree, id: 'repo-1::/w/fix-login', hostId: 'local' }
const projectRow: Worktree = { ...baseWorktree, id: 'repo-1::/w/plain', hostId: 'local' }

const filter = vi.fn()
const toggleGroup = vi.fn()
// "Send to agent" forces its target into Projects, as a row of the list even with Hide bot workspaces on.
let sendTarget: string | null
let collapsed: Set<string>
const forcedRow: WorktreeItemRow = {
  type: 'item',
  rowKey: 'forced-worker',
  sectionKey: 'repo:repo-1',
  repo,
  worktree: worker,
  depth: 0,
  groupDepth: 0,
  isLastLineageChild: false,
  lineageChildCount: 0
}
let activeId: string
let root: Root
let container: HTMLDivElement

function Probe() {
  const groupBy = useStore(store, (s) => s.groupBy)
  const pending = useStore(store, (s) => s.pendingRevealWorktree)
  const worktrees = [worker, projectRow]
  useSidebarRevealRequests({
    groupBy,
    renderedSidebarRowKeys: new Set(),
    // A user filter is on, and the filtered lists hold none of these rows.
    hasFilters: true,
    visibleWorktrees: [],
    visibleFolderWorkspaces: [],
    currentSidebarWorktreeId: activeId,
    currentSidebarExecutionHostId: 'local',
    worktreeMap: new Map(worktrees.map((row) => [row.id, row])),
    worktrees,
    folderWorkspaces: [home],
    revealWorkspaceFilters: filter
  })
  usePendingSidebarReveal({
    pendingRevealWorktree: pending,
    pendingRevealSidebarRow: null,
    clearPendingRevealWorktreeId: store.getState().clearPendingRevealWorktreeId,
    clearPendingRevealSidebarRow: store.getState().clearPendingRevealSidebarRow,
    agentSendTargetWorktreeId: sendTarget,
    renderRows: sendTarget === worker.id ? [forcedRow] : [],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reveal reads only scrollToIndex off the list's virtualizer.
    virtualizer: { scrollToIndex: vi.fn() } as never,
    scrollRef: { current: null },
    worktrees,
    folderWorkspaces: [home],
    repoMap: new Map([[repo.id, repo]]),
    worktreeMap: new Map(worktrees.map((row) => [row.id, row])),
    worktreeLineageById: {},
    collapsedGroups: collapsed,
    toggleGroup,
    groupBy,
    pinnedDisplayPolicy: 'duplicate-in-groups',
    defaultHostId: 'local',
    prCache: null,
    workspaceStatuses: [],
    settings: null,
    projectGroups: [],
    flashRevealedRow: vi.fn(),
    markRevealScroll: vi.fn(),
    schedulePendingRevealFrame: (callback) => {
      callback(0)
    },
    cancelPendingRevealFrames: vi.fn()
  })
  return null
}

beforeEach(() => {
  store = createUIStore()
  store.setState({
    activeView: 'terminal',
    activeWorkspaceExecutionHostId: 'local',
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    folderWorkspaces: [home],
    worktreesByRepo: { [repo.id]: [worker, projectRow] },
    settings: { ...getDefaultSettings('/home/me'), botsEnabled: true },
    hideBotCreatedWorkspaces: true,
    botSidebarView: { sortBy: 'manual', hidePausedBots: false, hideSleepingWorkers: false }
  })
  bots.list = [bot]
  children.map = new Map([[getFolderWorkspaceHostIdentity(home), [worker]]])
  confirm.mockReset().mockResolvedValue(true)
  filter.mockReset()
  toggleGroup.mockReset()
  sendTarget = null
  collapsed = new Set(['repo:repo-1'])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function open(workspaceId: string): void {
  activeId = workspaceId
  store.setState({
    activeWorkspaceKey: workspaceKeyOfRow(workspaceId),
    activeWorktreeId: workspaceId.startsWith('folder:') ? null : workspaceId
  })
  act(() => root.render(<Probe />))
}

async function clickRevealCurrent(): Promise<void> {
  await act(async () => {
    requestScrollToCurrentWorkspaceReveal()
    await Promise.resolve()
  })
}

it('on a bot page, never asks to adjust filters, changes none, and leaves no reveal pending', async () => {
  open('folder:home-1')
  await clickRevealCurrent()
  expect(confirm).not.toHaveBeenCalled()
  expect(filter).not.toHaveBeenCalled()
  expect(store.getState().pendingRevealWorktree).toBeNull()
})

it('on a bot-listed worker workspace, never asks, filters nothing, opens no repo group', async () => {
  open(worker.id)
  await clickRevealCurrent()
  expect(confirm).not.toHaveBeenCalled()
  expect(filter).not.toHaveBeenCalled()
  expect(toggleGroup).not.toHaveBeenCalled()
  expect(store.getState().pendingRevealWorktree).toBeNull()
})

it('drops a reveal another caller queues for a bot-owned workspace, opening no repo group', () => {
  open(projectRow.id)
  act(() => {
    store.getState().revealWorktreeInSidebar(worker.id, { executionHostId: 'local' })
  })
  expect(toggleGroup).not.toHaveBeenCalled()
  expect(store.getState().pendingRevealWorktree).toBeNull()
})

it('still asks before adjusting filters for a real Projects row a filter hides', async () => {
  open(projectRow.id)
  await clickRevealCurrent()
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(filter).toHaveBeenCalledTimes(1)
  expect(store.getState().pendingRevealWorktree).toMatchObject({ worktreeId: projectRow.id })
})

it("keeps Send to agent's reveal of a bot worker it forced into Projects, unfolding Projects for it", () => {
  // The forced row exists, but the Projects section is folded: the reveal waits for it, not drops.
  sendTarget = worker.id
  collapsed = new Set([PROJECTS_SECTION_GROUP_KEY])
  open(projectRow.id)
  act(() => {
    store
      .getState()
      .revealWorktreeInSidebar(worker.id, { executionHostId: 'local', highlight: true })
  })
  expect(toggleGroup).toHaveBeenCalledWith(PROJECTS_SECTION_GROUP_KEY)
  expect(store.getState().pendingRevealWorktree).toMatchObject({ worktreeId: worker.id })
})
