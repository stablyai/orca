/**
 * Terminal layout parity scenarios: each test drives a fixed terminal-layout journey and writes the
 * raw renderer layout and saved session to disk. `config/scripts/run-terminal-layout-parity.mjs` runs
 * this file against two builds and diffs the outputs; see tests/e2e/AGENTS.md.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { readPersistedProfileState } from './helpers/persisted-profile-state'
import {
  moveTerminalPaneByLeafId,
  readTerminalPaneDomLeafOrder,
  splitActiveTerminalPane,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  bootstrapFirstLaunch,
  bootstrapRestoredLaunch,
  seededRepoPathOrSkip
} from './helpers/terminal-restart-persistence'
import { createTerminalTabFromMenu, SORTABLE_TAB } from './helpers/terminal-tab-menu'
import {
  addFolderWorkspace,
  closeActivePaneFromKeyboard,
  dragPaneOutToTabStrip,
  waitForBoundPanes
} from './helpers/terminal-layout-journeys'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import {
  TERMINAL_LAYOUT_PARITY_OUT_ENV,
  type RawParityCheckpoint,
  type RawParityCapture
} from './terminal-layout-parity-snapshot'

test.describe.configure({ mode: 'serial' })

type Journey = {
  page: Page
  worktreeId: string
  userDataDir: string
}

/** Renderer topology for every worktree that has terminal tabs, plus mounted PaneManager DOM order. */
function readRendererLayout(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeIds = Object.keys(state.tabsByWorktree).filter(
      (id) => (state.tabsByWorktree[id] ?? []).length > 0
    )
    const pick = <T>(map: Record<string, T>): Record<string, T> =>
      Object.fromEntries(worktreeIds.filter((id) => id in map).map((id) => [id, map[id]]))
    const tabIds = worktreeIds.flatMap((id) => state.tabsByWorktree[id]!.map((tab) => tab.id))
    const mountedPanesByTabId = Object.fromEntries(
      tabIds.flatMap((tabId) => {
        const manager = window.__paneManagers?.get(tabId)
        if (!manager) {
          return []
        }
        const containers = new Set(manager.getPanes().map((pane) => pane.container))
        const leafOrder = Array.from(document.querySelectorAll<HTMLElement>('.pane[data-leaf-id]'))
          .filter((element) => containers.has(element))
          .map((element) => element.dataset.leafId ?? '')
        const active = manager.getActivePane()
        return [[tabId, { leafOrder, activeLeafId: active ? manager.getLeafId(active.id) : null }]]
      })
    )
    return {
      activeWorktreeId: state.activeWorktreeId,
      activeTabId: state.activeTabId,
      activeTabType: state.activeTabType,
      tabsByWorktree: pick(state.tabsByWorktree),
      terminalLayoutsByTabId: Object.fromEntries(
        tabIds.map((tabId) => [tabId, state.terminalLayoutsByTabId[tabId] ?? null])
      ),
      ptyIdsByTabId: Object.fromEntries(tabIds.map((tabId) => [tabId, state.ptyIdsByTabId[tabId]])),
      unifiedTabsByWorktree: pick(state.unifiedTabsByWorktree),
      groupsByWorktree: pick(state.groupsByWorktree),
      layoutByWorktree: pick(state.layoutByWorktree),
      activeTabIdByWorktree: pick(state.activeTabIdByWorktree),
      activeGroupIdByWorktree: pick(state.activeGroupIdByWorktree),
      mountedPanesByTabId
    }
  })
}

/** Host pacing: quit only after main lists exactly the terminals the renderer shows. */
async function waitForHostTerminals(journey: Journey): Promise<void> {
  const client = new RuntimeClient(journey.userDataDir, 30_000)
  const shown = await journey.page.evaluate((worktreeId) => {
    const state = window.__store!.getState()
    return (state.tabsByWorktree[worktreeId] ?? []).reduce((count, tab) => {
      const leafIds = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      return count + Math.max(1, Object.keys(leafIds).length)
    }, 0)
  }, journey.worktreeId)
  await expect
    .poll(
      async () => {
        const listed = await client
          .call<RuntimeTerminalListResult>('terminal.list', {
            worktree: `id:${journey.worktreeId}`
          })
          .catch(() => null)
        return listed?.result.terminals.length ?? -1
      },
      { timeout: 30_000, message: 'Host terminal list never matched the renderer' }
    )
    .toBe(shown)
}

/** Quiescence: the same layout on three consecutive reads, so a late echo cannot land after capture. */
async function readSettledRendererLayout(page: Page): Promise<unknown> {
  let previous = ''
  let stableReads = 0
  let latest: unknown = null
  await expect
    .poll(
      async () => {
        latest = await readRendererLayout(page)
        const serialized = JSON.stringify(latest)
        stableReads = serialized === previous ? stableReads + 1 : 0
        previous = serialized
        return stableReads
      },
      { timeout: 20_000, intervals: [300], message: 'Renderer layout never settled' }
    )
    .toBeGreaterThanOrEqual(2)
  return latest
}

function readPersistedSessions(userDataDir: string): unknown {
  const root = readPersistedProfileState(userDataDir)
  return { local: root.workspaceSession, byHostId: root.workspaceSessionsByHostId ?? {} }
}

function writeCapture(testInfo: TestInfo, capture: RawParityCapture): void {
  const outDir = process.env[TERMINAL_LAYOUT_PARITY_OUT_ENV] ?? testInfo.outputPath('parity')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    path.join(outDir, `${capture.scenario}.json`),
    `${JSON.stringify(capture, null, 2)}\n`
  )
}

type ScenarioSetup = {
  worktreeId: string
  pathLabels?: Record<string, string>
  cleanup?: () => void
}

type ParityScenario = {
  id: string
  setup?: (page: Page) => Promise<ScenarioSetup>
  journey: (journey: Journey) => Promise<void>
  /** Relaunch (`times`, default once) and capture each restored renderer and the next save. */
  restart?: { expectedPaneCount: number; times?: number }
}

/** Quit through the shared helper and report how the process ended; a forced kill skips the final save. */
async function quitAndReadExit(
  session: ReturnType<typeof createRestartSession>,
  app: ElectronApplication
): Promise<{ code: number | null; signal: string | null }> {
  const proc = app.process()
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve({ code: proc.exitCode, signal: proc.signalCode })
    }
    proc.once('exit', (code, signal) => resolve({ code, signal }))
  })
  await session.close(app)
  return exited
}

/** Launch on a fresh profile, run the journey, capture the settled renderer, quit and read the save. */
async function runScenario(testInfo: TestInfo, scenario: ParityScenario): Promise<void> {
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
  const checkpoints: RawParityCheckpoint[] = []
  let app: ElectronApplication | null = null
  let setup: ScenarioSetup | null = null
  try {
    const first = await session.launch()
    app = first.app
    setup = scenario.setup
      ? await scenario.setup(first.page)
      : await bootstrapFirstLaunch(first.page, repoPath)
    await waitForBoundPanes(first.page, 1)
    const journey = {
      page: first.page,
      worktreeId: setup.worktreeId,
      userDataDir: session.userDataDir
    }
    await scenario.journey(journey)
    await waitForHostTerminals(journey)
    const renderer = await readSettledRendererLayout(first.page)
    const exit = await quitAndReadExit(session, app)
    app = null
    const persisted = readPersistedSessions(session.userDataDir)
    checkpoints.push({ label: 'after-quit', renderer, persisted, exit })

    const { expectedPaneCount = 0, times: restarts = 1 } = scenario.restart ?? { times: 0 }
    for (let restart = 1; restart <= restarts; restart += 1) {
      const next = await session.launch()
      app = next.app
      await bootstrapRestoredLaunch(next.page, setup.worktreeId)
      await waitForBoundPanes(next.page, expectedPaneCount)
      const restored = await readSettledRendererLayout(next.page)
      const restartExit = await quitAndReadExit(session, app)
      app = null
      checkpoints.push({
        label: restart === 1 ? 'after-restart' : `after-restart-${restart}`,
        renderer: restored,
        persisted: readPersistedSessions(session.userDataDir),
        exit: restartExit
      })
    }
    writeCapture(testInfo, {
      scenario: scenario.id,
      pathLabels: {
        [repoPath]: '<repo>',
        [session.userDataDir]: '<userData>',
        ...setup.pathLabels
      },
      checkpoints
    })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    setup?.cleanup?.()
  }
}

async function splitTwice(page: Page): Promise<void> {
  await splitActiveTerminalPane(page, 'vertical')
  await waitForBoundPanes(page, 2)
  await splitActiveTerminalPane(page, 'horizontal')
  await waitForBoundPanes(page, 3)
}

async function splitThenNewTab(page: Page): Promise<void> {
  await splitActiveTerminalPane(page, 'vertical')
  await waitForBoundPanes(page, 2)
  await createTerminalTabFromMenu(page)
  await waitForActiveTerminalManager(page)
  await waitForBoundPanes(page, 1)
}

const SCENARIOS: ParityScenario[] = [
  {
    id: 'create-tab',
    journey: async ({ page }) => {
      await createTerminalTabFromMenu(page)
      await waitForActiveTerminalManager(page)
      await waitForBoundPanes(page, 1)
    }
  },
  { id: 'split-right-down', journey: ({ page }) => splitTwice(page) },
  {
    id: 'close-pane',
    journey: async ({ page }) => {
      await splitTwice(page)
      await closeActivePaneFromKeyboard(page, 3)
      await waitForBoundPanes(page, 2)
    }
  },
  {
    id: 'close-tab',
    journey: async ({ page }) => {
      await createTerminalTabFromMenu(page)
      await waitForActiveTerminalManager(page)
      await expect(page.locator(SORTABLE_TAB)).toHaveCount(2)
      const firstTab = page.locator(SORTABLE_TAB).first()
      await firstTab.getByRole('button', { name: /^Close tab /i }).click()
      await expect(page.locator(SORTABLE_TAB)).toHaveCount(1)
      await waitForActiveTerminalManager(page)
    }
  },
  {
    id: 'reorder-panes',
    journey: async ({ page }) => {
      await splitActiveTerminalPane(page, 'vertical')
      await waitForBoundPanes(page, 2)
      const [firstLeaf, secondLeaf] = await readTerminalPaneDomLeafOrder(page)
      await moveTerminalPaneByLeafId(page, secondLeaf!, firstLeaf!, 'left')
      await expect.poll(() => readTerminalPaneDomLeafOrder(page)).toEqual([secondLeaf, firstLeaf])
    }
  },
  {
    // Main-originated: the runtime RPC the CLI uses, not a renderer gesture.
    id: 'cli-split',
    journey: async ({ page, worktreeId, userDataDir }) => {
      const client = new RuntimeClient(userDataDir, 30_000)
      let handle: string | null = null
      await expect
        .poll(async () => {
          const listed = await client
            .call<RuntimeTerminalListResult>('terminal.list', { worktree: `id:${worktreeId}` })
            .catch(() => null)
          handle = listed?.result.terminals[0]?.handle ?? null
          return handle
        })
        .not.toBeNull()
      await client.call('terminal.split', { terminal: handle, direction: 'horizontal' })
      await waitForBoundPanes(page, 2)
    }
  },
  {
    id: 'drag-out-to-tab',
    journey: async (journey) => {
      const { page } = journey
      await splitActiveTerminalPane(page, 'vertical')
      await waitForBoundPanes(page, 2)
      const [, secondLeaf] = await readTerminalPaneDomLeafOrder(page)
      await dragPaneOutToTabStrip(page, journey.worktreeId, secondLeaf!)
      await expect(page.locator(SORTABLE_TAB)).toHaveCount(2)
      await waitForActiveTerminalManager(page)
      await waitForBoundPanes(page, 1)
    },
    restart: { expectedPaneCount: 1, times: 2 }
  },
  {
    id: 'restart-restore',
    journey: ({ page }) => splitThenNewTab(page),
    restart: { expectedPaneCount: 1 }
  },
  {
    id: 'folder-workspace',
    setup: addFolderWorkspace,
    journey: ({ page }) => splitThenNewTab(page)
  }
]

for (const scenario of SCENARIOS) {
  // oxlint-disable-next-line no-empty-pattern -- Each scenario owns its launches through createRestartSession.
  test(`parity: ${scenario.id}`, async ({}, testInfo) => runScenario(testInfo, scenario))
}
