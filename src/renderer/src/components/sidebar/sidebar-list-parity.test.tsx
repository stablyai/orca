// @vitest-environment happy-dom

/**
 * One store goes in; the window's own row pipeline (switch on), the desktop window reading main's
 * feed (useMainSidebarListModel) and a phone reading it (feed pages, the shared installer,
 * buildSidebarFeedRows) must draw the same list. The goldens check that list is right; this
 * checks only that the adapters agree.
 *
 * Never compared, as no feed input carries them: the window's drag previews, search, hover hold
 * and agent-send reveal; its imported-worktrees and new-external-worktrees cards; its create
 * preflight; host-header health and detail.
 * Known gaps the phone shows differently, so the fixture leaves them out: a creation a paired
 * server runs; a PR unlinked on a server workspace; an SSH workspace reached through a paired
 * server; a server terminal only another client opened (the server counts it, the window does not).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { SidebarInputsFeed } from '../../../../main/runtime/sidebar-inputs/sidebar-inputs-feed'
import { TestPhone } from '../../../../main/runtime/sidebar-inputs/sidebar-inputs-feed.test-fixture'
import { isActiveSidebarWorkspace } from '../../../../shared/sidebar-list/active-workspace'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { HostSectionRow } from '../../../../shared/sidebar-list/host-section-rows'
import type { readSidebarFeedDomains } from '../../../../shared/sidebar-list/sidebar-feed-domains'
import type { buildSidebarFeedRows } from '../../../../shared/sidebar-list/sidebar-feed-rows'
import { GOLDEN_NOW } from './sidebar-list-golden-factories.test-fixture'
import type { DesktopSidebarFeed } from '@/lib/desktop-sidebar-feed'
import { readSidebarFeedDomains as readFeedDomainsSwitchedOn } from '../../../../shared/sidebar-list/sidebar-feed-domains'
import { useMainSidebarListModel } from './worktree-list/listing/use-main-list-model'
import {
  GOLDEN_WORKTREE_IDS,
  buildGoldenStoreState,
  goldenLiveTerminalState,
  type GoldenView
} from './sidebar-list-golden-store.test-fixture'
import {
  GROUP_BYS,
  initialState,
  useGoldenSidebarPipeline
} from './sidebar-list-golden-suite.test-fixture'
import {
  feedDomainsFromWindowState,
  parityActiveState,
  parityServerBrowserTabState,
  parityServerTerminalState,
  parityWorldOverrides,
  phoneInputsFromWindowState,
  projectParityRows
} from './sidebar-list-parity.test-fixture'

const SWITCH = '../../../../shared/sidebar-inputs-switch'
vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
vi.mock('@/lib/sidebar-list-session', () => ({ useSidebarListSession: () => {} }))
// The feed the window would install from main; set per list.
let windowFeed: DesktopSidebarFeed | null = null
vi.mock('@/lib/desktop-sidebar-feed', () => ({
  useDesktopSidebarFeed: () => windowFeed,
  onDesktopSidebarFeedInstalled: () => () => {},
  refreshDesktopSidebarFeed: () => 0
}))

// The phone page is built without the switch, so its adapter loads in a module graph with it off.
let phoneAdapter: {
  readSidebarFeedDomains: typeof readSidebarFeedDomains
  buildSidebarFeedRows: typeof buildSidebarFeedRows
}
beforeAll(async () => {
  vi.resetModules()
  vi.doUnmock(SWITCH)
  expect(
    (await import('../../../../shared/sidebar-inputs-switch')).ORCA_SIDEBAR_INPUTS_IS_MAIN
  ).toBe(false)
  phoneAdapter = {
    ...(await import('../../../../shared/sidebar-list/sidebar-feed-domains')),
    ...(await import('../../../../shared/sidebar-list/sidebar-feed-rows'))
  }
})

const SORT_BYS: AppState['sortBy'][] = ['manual', 'name', 'recent', 'smart', 'repo']
const PROJECT_ORDER_BYS: AppState['projectOrderBy'][] = ['manual', 'recent']

function desktopActiveRowKeys(rows: readonly HostSectionRow[], state: AppState): Set<string> {
  const active = {
    worktreeId: state.activeWorktreeId,
    hostId: state.activeWorkspaceExecutionHostId ?? null
  }
  const keys = new Set<string>()
  for (const row of rows) {
    if (row.type === 'item' && isActiveSidebarWorkspace(row.worktree, active)) {
      keys.add(row.rowKey)
    } else if (
      row.type === 'folder-workspace' &&
      isActiveSidebarWorkspace(folderWorkspaceToWorktree(row.folderWorkspace), active)
    ) {
      keys.add(row.key)
    }
  }
  return keys
}

function desktopList(
  state: Partial<AppState>,
  useListModel?: Parameters<typeof useGoldenSidebarPipeline>[0]
): string[] {
  useAppStore.setState(state)
  const { result, unmount } = renderHook(() => useGoldenSidebarPipeline(useListModel))
  const { sectionRows } = result.current.rowModel
  const lines = projectParityRows(
    sectionRows,
    desktopActiveRowKeys(sectionRows, useAppStore.getState())
  )
  unmount()
  return lines
}

async function installFeed(state: Partial<AppState>) {
  useAppStore.setState(state)
  const full = useAppStore.getState()
  const feed = new SidebarInputsFeed(
    () => feedDomainsFromWindowState(full),
    () => {}
  )
  const phone = new TestPhone(feed, 'phone-1')
  phone.refresh()
  await phone.settle()
  phone.disconnect()
  const installed = phone.state.installed
  if (!installed) {
    throw new Error('the feed installed nothing')
  }
  return { installed, full }
}

async function phoneList(state: Partial<AppState>): Promise<string[]> {
  const { installed, full } = await installFeed(state)
  const domains = phoneAdapter.readSidebarFeedDomains(installed)
  expect(domains.projectCatalog?.repos.length).toBeGreaterThan(0)
  const { catalog, view } = phoneInputsFromWindowState(full, domains)
  const { sectionRows, activeRowKeys } = phoneAdapter.buildSidebarFeedRows(domains, catalog, view)
  return projectParityRows(sectionRows, activeRowKeys)
}

function worldState(view: GoldenView, extra: Partial<AppState> = {}): Partial<AppState> {
  const base = buildGoldenStoreState(view)
  return { ...base, ...parityWorldOverrides(base), ...extra }
}

/** The window's list built from main's feed, as an ORCA_SIDEBAR_INPUTS=main window draws it. */
async function windowFeedList(state: Partial<AppState>): Promise<string[]> {
  const { installed } = await installFeed(state)
  windowFeed = { domains: readFeedDomainsSwitchedOn(installed), readId: 1 }
  try {
    return desktopList(state, useMainSidebarListModel)
  } finally {
    windowFeed = null
  }
}

/** Every adapter over one store; the window's own list is the expected side. */
async function expectAdaptersAgree(state: Partial<AppState>): Promise<string[]> {
  const desktop = desktopList(state)
  useAppStore.setState(initialState, true)
  const phone = await phoneList(state)
  useAppStore.setState(initialState, true)
  const fromFeed = await windowFeedList(state)
  useAppStore.setState(initialState, true)
  expect(phone.join('\n')).toBe(desktop.join('\n'))
  expect(fromFeed.join('\n')).toBe(desktop.join('\n'))
  return desktop
}

/** Every other header collapsed, and the first lineage parent. */
function collapsedKeysOf(lines: readonly string[]): Set<string> {
  const keys = lines.flatMap((line) => {
    const header = /^HEADER (\S+) collapseKey=(\S+)/.exec(line)
    if (header) {
      return [header[2] === '-' ? header[1] : header[2]]
    }
    const host = /^HOST (\S+)/.exec(line)
    return host ? [host[1]] : []
  })
  const collapsed = new Set(keys.filter((_, index) => index % 2 === 0))
  const lineage = lines
    .map((line) => / lineageKey=(\S+)/.exec(line)?.[1])
    .find((key) => key && key !== '-')
  if (lineage) {
    collapsed.add(lineage)
  }
  return collapsed
}

describe('sidebar list parity: desktop window and feed reader', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(GOLDEN_NOW)
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    vi.useRealTimers()
  })

  for (const groupBy of GROUP_BYS) {
    it(`agrees for groupBy=${groupBy} across sort, project order, pinned policy and collapse`, async () => {
      for (const sortBy of SORT_BYS) {
        for (const projectOrderBy of PROJECT_ORDER_BYS) {
          for (const pinnedInGroups of [false, true]) {
            const view: GoldenView = {
              groupBy,
              sortBy,
              projectOrderBy,
              pinnedInGroups,
              collapsedGroups: new Set()
            }
            // Bare id: every occurrence highlights, a pinned duplicate included.
            const active = parityActiveState(GOLDEN_WORKTREE_IDS.orcaFeatA, null)
            const expanded = await expectAdaptersAgree(worldState(view, active))
            expect(expanded.filter((line) => line.endsWith(' ACTIVE')).length).toBe(
              pinnedInGroups ? 2 : 1
            )
            await expectAdaptersAgree(
              worldState({ ...view, collapsedGroups: collapsedKeysOf(expanded) }, active)
            )
          }
        }
      }
    })
  }

  // Each scenario with a line its expanded list must hold, so an empty list cannot pass.
  const SCENARIOS: Record<string, [Partial<AppState>, RegExp]> = {
    'host sections': [
      { visibleWorkspaceHostIds: ['local', 'ssh:gpu-vm', 'runtime:env-1'] },
      /^HOST \S+ host=runtime:env-1 label=Build server /
    ],
    'single host scope': [{ workspaceHostScope: 'ssh:gpu-vm' }, /^ITEM .*ssh:gpu-vm\|/],
    'paired server scope': [{ workspaceHostScope: 'runtime:env-1' }, /^ITEM .*runtime:env-1\|/],
    'repo filter': [{ filterRepoIds: ['orca', 'lab'] }, /^ITEM .*\|lab::/],
    'hide sleeping': [
      { showSleepingWorkspaces: false, ...goldenLiveTerminalState() },
      /^ITEM .*\|orca::\/w\/feat-a /
    ],
    // The server reports the desktop's terminal; only the desktop knows its browser tab.
    'hide sleeping with a paired server terminal': [
      { showSleepingWorkspaces: false, ...parityServerTerminalState() },
      /^ITEM .*runtime:env-1\|api::\/w\/api-y /
    ],
    'hide sleeping with a browser tab in a paired server workspace': [
      { showSleepingWorkspaces: false, ...parityServerBrowserTabState() },
      /^ITEM .*runtime:env-1\|api::\/w\/api-y /
    ],
    'hide default branch': [{ hideDefaultBranchWorkspace: true }, /^ITEM .*api-y /],
    // The same id on two hosts: only the SSH copy is open.
    'open on one of two hosts': [
      parityActiveState('shared::/w/same', 'ssh:gpu-vm'),
      /^ITEM \S*ssh:gpu-vm\|shared::\/w\/same .* ACTIVE$/
    ],
    'open folder workspace': [
      parityActiveState('folder:fw-remote', 'ssh:gpu-vm'),
      /^FOLDER folder-workspace:ssh:gpu-vm\|folder:fw-remote .* ACTIVE$/
    ],
    'open server folder workspace': [
      parityActiveState('folder:fw-server', 'runtime:env-1'),
      /^FOLDER folder-workspace:runtime:env-1\|folder:fw-server group=pg-server-folders .* ACTIVE$/
    ],
    'hide CLI-created': [
      { hideCliCreatedWorkspaces: true },
      /^ITEM .*runtime:env-1\|api::\/w\/api-y /
    ]
  }

  for (const [name, [overrides, shows]] of Object.entries(SCENARIOS)) {
    it(`agrees with ${name} across groupBy, pinned policy and collapse`, async () => {
      for (const groupBy of GROUP_BYS) {
        for (const pinnedInGroups of [false, true]) {
          const view: GoldenView = {
            groupBy,
            sortBy: 'manual',
            projectOrderBy: 'manual',
            pinnedInGroups,
            collapsedGroups: new Set()
          }
          const expanded = await expectAdaptersAgree(worldState(view, overrides))
          expect(expanded.some((line) => shows.test(line))).toBe(true)
          await expectAdaptersAgree(
            worldState({ ...view, collapsedGroups: collapsedKeysOf(expanded) }, overrides)
          )
        }
      }
    })
  }
})
