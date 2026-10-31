// @vitest-environment happy-dom
import {
  adoptEndpointRepo,
  adoptEndpointProjectCatalog
} from '../../../../shared/endpoint-catalog-adoption'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { buildProjectGroupingIndex } from '../../../../shared/project-section-grouping'

/** Exercise submenu focus timing and query reset, which flat-menu tests cannot cover. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerUIHandlers } from '../../../../main/ipc/ui'
import {
  createStore,
  closeTestStores,
  readPersistedState,
  testState,
  writeDataFile
} from '../../../../main/persistence/persistence-test-harness'
import { getDefaultPersistedState } from '../../../../shared/constants'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  state: {} as Record<string, unknown>
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(name, fn),
    on: () => {},
    removeAllListeners: () => {}
  },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] }
}))
vi.mock('../../../../main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'Unassigned' }))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  WorkspaceOptionsMenuItems,
  useWorkspaceOptionsFilterBadge
} from './workspace-options-menu-items'
import { useActivityScopeFilterCount } from '../activity/activity-scope-filter-controls'
import {
  filterWorkspaceRows,
  NO_WORKSPACE_ROW_FILTERS,
  type WorkspaceRowFactReader
} from '../../../../shared/workspace-view/workspace-row-filters'
import { TooltipProvider } from '@/components/ui/tooltip'
import SidebarFilter from './SidebarFilter'
import { useProjectFilterOptions } from './use-project-filter-options'
import SidebarRepositoryFilterSection from './SidebarRepositoryFilterSection'

const REPOS = [
  { id: 'r1', displayName: 'alpha', path: '/tmp/alpha' },
  { id: 'r2', displayName: 'beta', path: '/tmp/beta' },
  { id: 'r3', displayName: 'gamma', path: '/tmp/gamma' }
]

let container: HTMLDivElement
let root: Root
let setFilterRepoIds: ReturnType<typeof vi.fn>

function setState(overrides: Record<string, unknown> = {}): void {
  setFilterRepoIds = vi.fn()
  mocks.state = {
    repos: REPOS,
    groupBy: 'none',
    sortBy: 'name',
    projectOrderBy: 'manual',
    settings: { experimentalNewWorktreeCardStyle: false },
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    runtimeStatusByEnvironmentId: new Map(),
    sshTargetLabels: new Map(),
    sshConnectionStates: new Map(),
    wslHostStatuses: new Map(),
    worktreeCardProperties: [],
    projectGroups: [],
    worktreeCardMode: 'detailed',
    agentActivityDisplayMode: 'compact',
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    showSleepingWorkspaces: true,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: null,
    agentsVisibleHostIds: null,
    agentsFilterRepoIds: [],

    filterRepoIds: [],
    setFilterRepoIds,
    ...overrides
  }
}

function Badges() {
  const badge = useWorkspaceOptionsFilterBadge()
  const agents = useActivityScopeFilterCount()
  return (
    <output data-badges>
      {badge.activeFilterCount}:{agents}
    </output>
  )
}
function render(outer = false): void {
  act(() => {
    root.render(
      <DropdownMenu defaultOpen>
        <Badges />
        <DropdownMenuTrigger>Options</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Sort by</DropdownMenuItem>
          {outer ? <WorkspaceOptionsMenuItems /> : <SidebarRepositoryFilterSection />}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  })
}

function openSubmenu(): void {
  const trigger = [
    ...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
  ].find((node) => node.textContent?.startsWith('Projects'))
  if (!trigger) {
    throw new Error('sub-trigger not rendered')
  }
  act(() => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }))
    trigger.click()
  })
}

function closeSubmenu(): void {
  const content = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-content"]')
  if (!content) {
    throw new Error('sub-content not rendered')
  }
  act(() => {
    content.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
    )
  })
}

function searchInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[data-slot="command-input"]')
}

/** Allow deferred focus to settle through one frame and a macrotask. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
  })
}

/** Types into whatever currently holds focus, so routing is part of the assertion. */
function typeIntoFocused(value: string): void {
  const input = document.activeElement
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`focus is on ${document.activeElement?.nodeName ?? 'nothing'}, not an input`)
  }
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Radix probes pointer capture and scrolling that happy-dom does not model.
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
  setState()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('SidebarRepositoryFilterSection', () => {
  it('focuses the search input when the submenu opens', async () => {
    render()
    openSubmenu()
    await settle()

    expect(searchInput()).not.toBeNull()
    expect(document.activeElement).toBe(searchInput())
  })

  it('routes typing into the search box rather than menu typeahead', async () => {
    render()
    openSubmenu()
    await settle()
    typeIntoFocused('alp')

    expect(searchInput()?.value).toBe('alp')
  })

  it('resets the query when the panel is reopened', async () => {
    render()
    openSubmenu()
    await settle()
    typeIntoFocused('alp')
    expect(searchInput()?.value).toBe('alp')

    closeSubmenu()
    expect(searchInput()).toBeNull()

    openSubmenu()
    await settle()
    expect(searchInput()?.value).toBe('')
  })

  it('keeps ArrowLeft in the text field while the caret can still move', async () => {
    render()
    openSubmenu()
    await settle()
    typeIntoFocused('alp')

    const input = searchInput()
    input?.setSelectionRange(3, 3)
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
      )
    })

    expect(searchInput()).not.toBeNull()
  })

  it('lets ArrowLeft close the panel once the caret is at the start', async () => {
    render()
    openSubmenu()
    await settle()

    const input = searchInput()
    input?.setSelectionRange(0, 0)
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
      )
    })

    expect(searchInput()).toBeNull()
  })

  it('hides itself when only one project exists', () => {
    setState({ repos: [REPOS[0]] })
    render()

    expect(document.querySelector('[data-slot="dropdown-menu-sub-trigger"]')).toBeNull()
  })
})

const checkoutRows = [
  { id: 'a', host: 'local' as const, folder: false },
  { id: 'b', host: 'local' as const, folder: false },
  { id: 'same', host: 'local' as const, folder: false },
  { id: 'same', host: 'runtime:server' as const, folder: false },
  { id: 'folder', host: 'local' as const, folder: true }
]
const read: WorkspaceRowFactReader<(typeof checkoutRows)[number]> = {
  repoId: (row) => row.id,
  hostId: (row) => row.host,
  isFolderWorkspace: (row) => row.folder,
  isArchived: () => false,
  isOtherClient: () => false,
  isDefaultBranch: () => false,
  isAutomationCreated: () => false,
  isCliCreated: () => false,
  isDetachedHead: () => false,
  isMainWorktree: () => false,
  isSleeping: () => false
}
const grouped = [
  { id: 'a', path: '/a', displayName: 'App', upstream: { owner: 'org', repo: 'app' } },
  { id: 'b', path: '/b', displayName: 'App', upstream: { owner: 'org', repo: 'app' } }
]
const visible = (ids: string[]) =>
  filterWorkspaceRows(checkoutRows, { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: ids }, read).map(
    (row) => row.id
  )

it('shows partial upgraded scope through pills, badge and rows; complete/remove preserve offline intent', async () => {
  const saved = ['a', 'offline']
  setState({ repos: grouped, filterRepoIds: saved, agentsFilterRepoIds: saved })
  render(true)
  openSubmenu()
  await settle()
  expect(document.body.textContent).toContain('Partially selected')
  expect(document.body.textContent).toContain('Unavailable projects')
  expect(document.querySelector('[data-badges]')?.textContent).toBe('1:1')
  expect(visible(saved)).toEqual(['a', 'folder'])
  expect(saved).toEqual(['a', 'offline'])
  act(() =>
    searchInput()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  expect(setFilterRepoIds).toHaveBeenLastCalledWith(['offline', 'a', 'b'])
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Remove App filter"]')!.click())
  expect(setFilterRepoIds).toHaveBeenLastCalledWith(['offline'])
  const clear = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Clear'
  )!
  expect(clear.disabled).toBe(false)
  act(() => clear.click())
  expect(setFilterRepoIds).toHaveBeenLastCalledWith([])
  expect(visible([])).toEqual(checkoutRows.map((row) => row.id))
})

it.each([[[]], [[grouped[0]]]])(
  'keeps unknown-only saved selection visible and exactly clearable with catalog %j',
  async (...[repos]) => {
    setState({ repos, filterRepoIds: ['offline'], agentsFilterRepoIds: ['offline'] })
    render(true)
    openSubmenu()
    await settle()
    expect(document.body.textContent).toContain('Saved project selection')
    expect(document.body.textContent).toContain('Unavailable projects')
    expect(document.querySelector('[data-badges]')?.textContent).toBe('1:1')
    expect(visible(['offline'])).toEqual(['folder'])
    const clear = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Clear'
    )!
    expect(clear.disabled).toBe(false)
    act(() => clear.click())
    expect(setFilterRepoIds).toHaveBeenCalledWith([])
  }
)

it('keeps qualified host twins restricted and keeps an explicit all-known allow list active', async () => {
  const twin = { ...grouped[0], id: 'same' }
  const repos = [twin, { ...twin, executionHostId: 'runtime:server' as const }]
  setState({ repos, filterRepoIds: ['runtime:server\0same'] })
  render()
  openSubmenu()
  await settle()
  expect(document.body.textContent).toContain('Partially selected')
  expect(document.querySelector('[data-badges]')?.textContent).toBe('1:0')
  expect(
    filterWorkspaceRows(
      checkoutRows,
      { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: ['runtime:server\0same'] },
      read
    )
  ).toEqual([checkoutRows[3], checkoutRows[4]])
  setState({ repos: grouped, filterRepoIds: ['a', 'b'] })
  render()
  await settle()
  expect(document.querySelector('[data-badges]')?.textContent).toBe('1:0')
  expect(
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Clear')
      ?.disabled
  ).toBe(false)
})

it('keeps the flat Projects checkboxes partial and Reset enabled through mode changes and offline-only scope', async () => {
  const saved = ['a', 'offline']
  setState({ repos: grouped, filterRepoIds: saved, settings: { projectGroupingMode: 'folder' } })
  const flat = () =>
    act(() =>
      root.render(
        <TooltipProvider>
          <SidebarFilter onMenuOpenChange={() => {}} />
        </TooltipProvider>
      )
    )
  flat()
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="Edit filters (1 active)"]'
  )!
  act(() =>
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
  )
  await settle()
  expect(document.body.textContent).not.toContain('Partially selected')
  mocks.state.settings = { projectGroupingMode: 'repository' }
  flat()
  await settle()
  expect(document.body.textContent).toContain('Partially selected')
  const selectAll = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Select all'
  )!
  expect(selectAll.disabled).toBe(false)
  act(() => selectAll.click())
  expect(setFilterRepoIds).toHaveBeenLastCalledWith(['offline', 'a', 'b'])
  expect(saved).toEqual(['a', 'offline'])
  mocks.state.filterRepoIds = ['offline']
  mocks.state.repos = []
  flat()
  await settle()
  expect(document.body.textContent).toContain('Saved project selection')
  const reset = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Reset filters'
  )!
  expect(reset).toBeDefined()
  act(() => reset.click())
  expect(setFilterRepoIds).toHaveBeenLastCalledWith([])
})

it.each([100, 1000])(
  'bounds actual Projects summary, pills, search and flat checkbox membership work for %i groups',
  async (count) => {
    const repos = Array.from({ length: count }, (_, group) =>
      ['a', 'b'].map((checkout) => ({
        id: `${group}-${checkout}`,
        displayName: `App ${group}`,
        path: `/${group}/${checkout}`,
        upstream: { owner: 'org', repo: `app-${group}` }
      }))
    ).flat()
    setState({ repos, filterRepoIds: Array.from({ length: count }, (_, group) => `${group}-a`) })
    let membershipVisits = 0
    const originalIncludes = Array.prototype.includes
    const originalHas = Set.prototype.has
    vi.spyOn(Array.prototype, 'includes').mockImplementation(function (
      this: unknown[],
      value: unknown,
      from?: number
    ) {
      if (typeof value === 'string' && value.startsWith('project:')) {
        membershipVisits += this.length
      }
      return originalIncludes.call(this, value, from)
    })
    vi.spyOn(Set.prototype, 'has').mockImplementation(function (
      this: Set<unknown>,
      value: unknown
    ) {
      if (typeof value === 'string' && value.startsWith('project:')) {
        membershipVisits++
      }
      return originalHas.call(this, value)
    })
    render()
    openSubmenu()
    await settle()
    expect(document.querySelectorAll('[aria-label^="Remove App "]')).toHaveLength(count)
    expect(membershipVisits).toBeGreaterThan(count)
    expect(membershipVisits).toBeLessThan(60 * count)
    membershipVisits = 0
    typeIntoFocused('App 99')
    await settle()
    expect(membershipVisits).toBeLessThan(20 * count)
    closeSubmenu()
    membershipVisits = 0
    act(() =>
      root.render(
        <TooltipProvider>
          <SidebarFilter onMenuOpenChange={() => {}} />
        </TooltipProvider>
      )
    )
    const trigger = document.querySelector<HTMLButtonElement>(
      `[aria-label="Edit filters (${count} active)"]`
    )!
    expect(trigger).toBeTruthy()
    act(() =>
      trigger.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      )
    )
    await settle()
    expect(document.body.textContent).toContain('Partially selected')
    expect(membershipVisits).toBeGreaterThan(count)
    expect(membershipVisits).toBeLessThan(60 * count)
  }
)

it.each([
  [100, 100],
  [1000, 100],
  [100, 1000],
  [1000, 1000]
])(
  'bounds known-old real Select all with %i retained and %i displayed raw keys',
  async (retained, shown) => {
    window.history.replaceState(null, '', '/web-index.html')
    const keys = Array.from({ length: shown }, (_, i) => `raw-${i}`)
    const previous = Array.from({ length: retained }, (_, i) => `raw-${i + 1}`)
    setState({
      repos: keys.map((id) => ({ id, path: `/${id}`, displayName: id })),
      filterRepoIds: previous,
      runtimeEnvironments: [{ id: 'old' }],
      runtimeStatusByEnvironmentId: new Map([
        [
          'old',
          {
            snapshot: {
              verification: 'verified',
              transport: 'ready',
              retired: false,
              status: { capabilities: [] }
            }
          }
        ]
      ])
    })
    act(() =>
      root.render(
        <TooltipProvider>
          <SidebarFilter onMenuOpenChange={() => {}} />
        </TooltipProvider>
      )
    )
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label^="Edit filters"]')!
    act(() =>
      trigger.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      )
    )
    await settle()
    const selectAll = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === 'Select all'
    )!
    expect(selectAll).toBeTruthy()
    expect(selectAll.disabled).toBe(false)
    let membership = 0
    const includes = Array.prototype.includes
    const has = Set.prototype.has
    vi.spyOn(Array.prototype, 'includes').mockImplementation(function (
      this: unknown[],
      value: unknown,
      from?: number
    ) {
      if (typeof value === 'string' && value.startsWith('raw-')) {
        membership += this.length
      }
      return includes.call(this, value, from)
    })
    vi.spyOn(Set.prototype, 'has').mockImplementation(function (
      this: Set<unknown>,
      value: unknown
    ) {
      if (typeof value === 'string' && value.startsWith('raw-')) {
        membership++
      }
      return has.call(this, value)
    })
    act(() => selectAll.click())
    const actionMembership = membership
    process.stdout.write(`PG6-A ${JSON.stringify({ retained, shown, actionMembership })}\n`)
    const touched = new Set(keys)
    expect(setFilterRepoIds).toHaveBeenLastCalledWith([
      ...new Set([...previous.filter((id) => !touched.has(id)), ...keys])
    ])
    expect(actionMembership).toBeGreaterThanOrEqual(retained)
    expect(actionMembership).toBeLessThanOrEqual(4 * (retained + shown))
    const clear = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Clear'
    )!
    act(() => clear.click())
    expect(setFilterRepoIds).toHaveBeenLastCalledWith([])
    window.history.replaceState(null, '', '/')
  }
)

it('keeps literal old-owner remove/complete/empty semantics for duplicates and offline opaque tokens', () => {
  window.history.replaceState(null, '', '/web-index.html')
  const previous = ['raw-a', 'local\0raw-a', 'raw-a', 'offline']
  setState({
    filterRepoIds: previous,
    runtimeEnvironments: [{ id: 'old' }],
    runtimeStatusByEnvironmentId: new Map([
      [
        'old',
        {
          snapshot: {
            verification: 'verified',
            transport: 'ready',
            retired: false,
            status: { capabilities: [] }
          }
        }
      ]
    ])
  })
  let edit: ReturnType<typeof useProjectFilterOptions>['edit'] = () => []
  function Capture() {
    edit = useProjectFilterOptions(previous).edit
    return null
  }
  act(() => root.render(<Capture />))
  expect(edit('remove', ['raw-a', 'raw-a'])).toEqual(['local\0raw-a', 'offline'])
  expect(edit('complete', ['raw-b', 'raw-b', 'unavailable'])).toEqual([
    'raw-a',
    'local\0raw-a',
    'offline',
    'raw-b',
    'unavailable'
  ])
  expect(edit('remove', [])).toEqual(['raw-a', 'local\0raw-a', 'offline'])
  expect(edit('remove', ['missing'])).toEqual(['raw-a', 'local\0raw-a', 'offline'])
})

it('completes the actual adopted nested Hx in Projects without borrowing Hy from the transport/raw winner', async () => {
  const target = { kind: 'environment', environmentId: 'E' } as const
  const authored = [
    { id: 'r', connectionId: 'x', executionHostId: 'ssh:x' as const, path: '/srv/r' },
    { id: 'r', connectionId: 'y', executionHostId: 'ssh:y' as const, path: '/srv/r' },
    { id: 'q', connectionId: 'y', executionHostId: 'ssh:y' as const, path: '/srv/q' }
  ].map((repo) => ({
    ...repo,
    displayName: repo.path,
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'app' }
  }))
  const original = projectHostSetupProjectionFromRepos(authored)
  const projection = adoptEndpointProjectCatalog(target, original.projects, original.setups)
  const repos = authored.map((repo) => adoptEndpointRepo(target, repo))
  setState({
    repos,
    projects: projection.projects,
    projectHostSetups: projection.setups,
    filterRepoIds: ['offline'],
    settings: { projectGroupingMode: 'host' }
  })
  let options: ReturnType<typeof useProjectFilterOptions> | undefined
  function Capture() {
    options = useProjectFilterOptions(['offline'])
    return null
  }
  act(() => root.render(<Capture />))
  const index = buildProjectGroupingIndex({
    projects: projection.projects,
    projectHostSetups: projection.setups,
    settings: { projectGroupingMode: 'host' }
  })
  const hx = index.groups.find((group) => group.registrations.includes(projection.setups[0]))!
  expect(options!.repos.map((repo) => repo.id)).toContain(hx.key)
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-nested-filter-'))
  writeDataFile({ ...getDefaultPersistedState(testState.dir), repos: authored })
  const store = createStore()
  registerUIHandlers(store)
  setFilterRepoIds.mockImplementation((ids: string[]) =>
    mocks.handlers.get('ui:set')!({}, { filterRepoIds: ids })
  )
  try {
    render(true)
    openSubmenu()
    await settle()
    act(() =>
      searchInput()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    expect(setFilterRepoIds).toHaveBeenLastCalledWith(['offline', 'ssh:x\0r'])
    expect(store.getUI().filterRepoIds).toEqual(['offline', 'ssh:x\0r'])
    store.flush()
    expect(readPersistedState().ui.filterRepoIds).toEqual(['offline', 'ssh:x\0r'])
    const rows = [
      { id: 'r', host: 'ssh:x' as const, name: 'wx' },
      { id: 'r', host: 'ssh:y' as const, name: 'wy' },
      { id: 'q', host: 'ssh:y' as const, name: 'wq' }
    ]
    const reader: WorkspaceRowFactReader<(typeof rows)[number]> = {
      repoId: (row) => row.id,
      hostId: (row) => row.host,
      isArchived: () => false,
      isFolderWorkspace: () => false,
      isOtherClient: () => false,
      isDefaultBranch: () => false,
      isAutomationCreated: () => false,
      isCliCreated: () => false,
      isDetachedHead: () => false,
      isMainWorktree: () => false,
      isSleeping: () => false
    }
    const visible = (ids: string[]) =>
      filterWorkspaceRows(rows, { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: ids }, reader).map(
        (row) => row.name
      )
    expect(visible(['offline', 'r'])).toEqual(['wx', 'wy'])
    expect(visible(store.getUI().filterRepoIds)).toEqual(['wx'])
    expect(visible(['runtime:E\0r'])).toEqual([])
    mocks.state.filterRepoIds = ['offline', 'ssh:x\0r']
    render(true)
    await settle()
    expect(document.querySelector('[data-badges]')?.textContent).toBe('1:0')
    expect(document.body.textContent).toContain('Unavailable projects')
    await closeTestStores()
    const restored = createStore().getUI().filterRepoIds
    expect(restored).toContain('ssh:x\0r')
    expect(visible(restored)).toEqual(['wx'])
  } finally {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  }
})
