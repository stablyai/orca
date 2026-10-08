/**
 * Terminal layout parity scenarios: each test drives a fixed terminal-layout journey and writes the
 * raw renderer layout and saved session to disk. `config/scripts/run-terminal-layout-parity.mjs` runs
 * this file against two builds and diffs the outputs; see tests/e2e/AGENTS.md.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { readPersistedProfileState } from './helpers/persisted-profile-state'
import {
  countVisibleTerminalPanes,
  focusActiveTerminalInput,
  moveTerminalPaneByLeafId,
  readTerminalPaneDomLeafOrder,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  bootstrapFirstLaunch,
  bootstrapRestoredLaunch,
  seededRepoPathOrSkip
} from './helpers/terminal-restart-persistence'
import { createTerminalTabFromMenu, SORTABLE_TAB } from './helpers/terminal-tab-menu'
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

/** Human pacing: the next gesture waits until every pane of the active tab has a bound PTY. */
async function waitForBoundPanes(page: Page, count: number): Promise<void> {
  await waitForPaneCount(page, count, 30_000)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__store!.getState()
          const manager = state.activeTabId ? window.__paneManagers?.get(state.activeTabId) : null
          const bound = state.activeTabId
            ? state.terminalLayoutsByTabId[state.activeTabId]?.ptyIdsByLeafId
            : undefined
          return (manager?.getPanes() ?? []).every((pane) => {
            const leafId = manager!.getLeafId(pane.id)
            return leafId !== null && Boolean(bound?.[leafId])
          })
        }),
      { timeout: 30_000, message: 'A pane never bound its PTY' }
    )
    .toBe(true)
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

async function addFolderWorkspace(page: Page): Promise<ScenarioSetup> {
  const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-parity-folder-')))
  const cleanup = (): void => rmSync(folderPath, { recursive: true, force: true })
  const repoId = await page.evaluate(async (folder) => {
    const result = await window.api.repos.add({ path: folder, kind: 'folder' })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, folderPath)
  await waitForSessionReady(page)
  let worktreeId: string | null = null
  await expect
    .poll(async () => {
      worktreeId = await page.evaluate(async (id) => {
        const store = window.__store!
        await store.getState().fetchRepos()
        await store.getState().fetchWorktrees(id)
        const worktree = store.getState().worktreesByRepo[id]?.[0]
        if (worktree) {
          store.getState().setActiveWorktree(worktree.id)
        }
        return worktree?.id ?? null
      }, repoId)
      return worktreeId
    })
    .not.toBeNull()
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  return { worktreeId: worktreeId!, pathLabels: { [folderPath]: '<folder>' }, cleanup }
}

/**
 * The user's close-pane chord, so the close reaches main through the real commit path; driving
 * PaneManager.closePane directly leaves main to learn of it from the PTY exit, which races quit.
 */
async function closeActivePaneFromKeyboard(page: Page, paneCount: number): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
  // A fresh shell can still read as busy, which asks before stopping it.
  const confirm = page.getByRole('button', { name: 'Stop and Close' })
  await expect
    .poll(
      async () => {
        if (await confirm.isVisible().catch(() => false)) {
          await confirm.click()
        }
        return countVisibleTerminalPanes(page)
      },
      { timeout: 10_000, intervals: [50] }
    )
    .toBe(paneCount - 1)
}

/** A real pointer drag of a pane's handle onto the tab strip, past the last tab, as a user drags a pane out. */
async function dragPaneOutToTabStrip(journey: Journey, leafId: string): Promise<void> {
  const { page, worktreeId } = journey
  const handle = page.locator(`.pane[data-leaf-id="${leafId}"] .pane-drag-handle`)
  const strip = page.locator(`[data-tab-group-strip-id][data-worktree-id="${worktreeId}"]`).first()
  const lastTab = strip.locator(SORTABLE_TAB).last()
  const handleBox = await handle.boundingBox()
  const stripBox = await strip.boundingBox()
  const lastTabBox = await lastTab.boundingBox()
  if (!handleBox || !stripBox || !lastTabBox) {
    throw new Error('Pane drag handle or tab strip is not laid out')
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 4)
  await page.mouse.down()
  await page.mouse.move(
    Math.min(lastTabBox.x + lastTabBox.width + 24, stripBox.x + stripBox.width - 4),
    stripBox.y + stripBox.height / 2,
    { steps: 20 }
  )
  await page.mouse.up()
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
      await dragPaneOutToTabStrip(journey, secondLeaf!)
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
