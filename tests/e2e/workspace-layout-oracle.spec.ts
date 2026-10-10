/**
 * Layout oracle scenarios with a window attached. Each drives a layout journey through the same
 * commands a user, the CLI or a paired client sends, and after every step checks the runtime's
 * layout against the structural rules, the window's DOM, the paired-client and CLI views, the
 * expected end layout and, where the journey restarts, the layout from before the restart.
 *
 * Findings a scenario still has on main are listed in `workspace-layout-oracle-known-on-main.ts`;
 * any other finding fails. `ORCA_LAYOUT_ORACLE_RECORD=1` records without failing.
 * `ORCA_LAYOUT_ORACLE_REPEAT=<n>` repeats every scenario n times (catch-rate measurement).
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  moveTerminalPaneByLeafId,
  readTerminalPaneDomLeafOrder,
  splitActiveTerminalPane,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { bootstrapFirstLaunch, seededRepoPathOrSkip } from './helpers/terminal-restart-persistence'
import { createTerminalTabFromMenu, SORTABLE_TAB } from './helpers/terminal-tab-menu'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  addFolderWorkspace,
  closeActivePaneFromKeyboard,
  dragPaneOutToTabStrip,
  waitForBoundPanes
} from './helpers/terminal-layout-journeys'
import {
  addHostCreatedSetupSplitWorktree,
  openSetupSplitWorktree,
  sleepAgentPane,
  wakeByClick
} from './helpers/setup-split-and-sleep-journeys'
import { runOracleScenario, type OracleRun } from './helpers/workspace-layout-oracle-session'
import { unexpectedFindings } from './workspace-layout-oracle-known-on-main'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'

type Scenario = {
  id: string
  /** Defaults to the seeded repo's first worktree with one terminal. */
  setup?: (run: OracleRun) => Promise<{ worktreeId: string; cleanup?: () => void }>
  journey: (run: OracleRun, worktreeId: string) => Promise<void>
  /** False where a pane runs an agent, not a shell, so an echo proves nothing. */
  endMarkers?: false
}

async function listTerminals(run: OracleRun, worktreeId: string) {
  const listed = await run.client.call<RuntimeTerminalListResult>('terminal.list', {
    worktree: `id:${worktreeId}`
  })
  return listed.result.terminals
}

async function firstHandle(run: OracleRun, worktreeId: string): Promise<string> {
  let handle: string | undefined
  await expect
    .poll(async () => {
      handle = (await listTerminals(run, worktreeId).catch(() => []))[0]?.handle
      return handle
    })
    .toBeDefined()
  return handle!
}

/** The relaunched window shows the worktree again, however many panes its tab restores. */
async function reopenActiveWorktree(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
}

async function splitTwice(page: Page): Promise<void> {
  await splitActiveTerminalPane(page, 'vertical')
  await waitForBoundPanes(page, 2)
  await splitActiveTerminalPane(page, 'horizontal')
  await waitForBoundPanes(page, 3)
}

async function newTabFromMenu(page: Page): Promise<void> {
  // The tab menu can miss a click while the previous tab's menu is still closing.
  await createTerminalTabFromMenu(page).catch(async () => {
    await page.keyboard.press('Escape')
    await createTerminalTabFromMenu(page)
  })
  await waitForActiveTerminalManager(page)
  await waitForBoundPanes(page, 1)
}

const SCENARIOS: Scenario[] = [
  {
    id: 'create-tab',
    journey: async (run, worktreeId) => {
      await newTabFromMenu(run.page)
      await run.oracle.step('new tab', { worktreeId, panesPerTab: [1, 1] })
    }
  },
  {
    id: 'split-right-down',
    journey: async (run, worktreeId) => {
      await splitTwice(run.page)
      await run.oracle.step('split twice', { worktreeId, panesPerTab: [3] })
    }
  },
  {
    id: 'close-pane',
    journey: async (run, worktreeId) => {
      await splitTwice(run.page)
      await run.oracle.step('split twice', { worktreeId, panesPerTab: [3] })
      await closeActivePaneFromKeyboard(run.page, 3)
      await run.oracle.step('close pane', { worktreeId, panesPerTab: [2], removed: 1 })
    }
  },
  {
    id: 'close-tab',
    journey: async (run, worktreeId) => {
      await newTabFromMenu(run.page)
      await run.oracle.step('new tab', { worktreeId, panesPerTab: [1, 1] })
      const firstTab = run.page.locator(SORTABLE_TAB).first()
      await firstTab.getByRole('button', { name: /^Close tab /i }).click()
      await expect(run.page.locator(SORTABLE_TAB)).toHaveCount(1)
      await run.oracle.step('close first tab', { worktreeId, panesPerTab: [1], removed: 1 })
    }
  },
  {
    id: 'reorder-panes',
    journey: async (run, worktreeId) => {
      await splitActiveTerminalPane(run.page, 'vertical')
      await waitForBoundPanes(run.page, 2)
      const [firstLeaf, secondLeaf] = await readTerminalPaneDomLeafOrder(run.page)
      await moveTerminalPaneByLeafId(run.page, secondLeaf!, firstLeaf!, 'left')
      await expect
        .poll(() => readTerminalPaneDomLeafOrder(run.page))
        .toEqual([secondLeaf, firstLeaf])
      await run.oracle.step('swap panes', { worktreeId, panesPerTab: [2] })
    }
  },
  {
    // A paired client reorders the tab bar through the runtime command.
    id: 'client-reorder-tabs',
    journey: async (run, worktreeId) => {
      await newTabFromMenu(run.page)
      await newTabFromMenu(run.page)
      await run.oracle.step('three tabs', { worktreeId, panesPerTab: [1, 1, 1] })
      const tabs = await run.client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
        worktree: `id:${worktreeId}`
      })
      const group = tabs.result.tabGroups?.[0]
      expect(group?.tabOrder.length).toBe(3)
      const reversed = group!.tabOrder.toReversed()
      await run.client.call('session.tabs.move', {
        worktree: `id:${worktreeId}`,
        tabId: reversed[0],
        targetGroupId: group!.id,
        kind: 'reorder',
        tabOrder: reversed
      })
      await run.oracle.step('client reverses tab order', { worktreeId, panesPerTab: [1, 1, 1] })
    }
  },
  {
    // STA-9259: the dragged-out pane must live in exactly one tab, across two restarts.
    id: 'drag-out-to-tab',
    journey: async (run, worktreeId) => {
      await splitActiveTerminalPane(run.page, 'vertical')
      await waitForBoundPanes(run.page, 2)
      const [, secondLeaf] = await readTerminalPaneDomLeafOrder(run.page)
      await dragPaneOutToTabStrip(run.page, worktreeId, secondLeaf!)
      await expect(run.page.locator(SORTABLE_TAB)).toHaveCount(2)
      await waitForBoundPanes(run.page, 1)
      await run.oracle.step('drag pane out', { worktreeId, panesPerTab: [1, 1] })
      await run.relaunch({ worktreeId, paneCount: 1, panesPerTab: [1, 1] })
      await run.relaunch({ worktreeId, paneCount: 1, panesPerTab: [1, 1] })
    }
  },
  {
    id: 'cli-split',
    journey: async (run, worktreeId) => {
      const handle = await firstHandle(run, worktreeId)
      await run.client.call('terminal.split', { terminal: handle, direction: 'horizontal' })
      await waitForBoundPanes(run.page, 2)
      await run.oracle.step('CLI split', { worktreeId, panesPerTab: [2] })
    }
  },
  {
    // #19582 and #10747 with a window: a CLI-created tab, renamed, then closed.
    id: 'cli-create-rename-close',
    journey: async (run, worktreeId) => {
      await run.client.call('terminal.create', { worktree: `id:${worktreeId}` })
      await expect.poll(async () => (await listTerminals(run, worktreeId)).length).toBe(2)
      await run.oracle.step('CLI create', { worktreeId, panesPerTab: [1, 1] })
      const created = (await listTerminals(run, worktreeId))[1]!
      await run.client.call('terminal.rename', {
        terminal: created.handle,
        title: 'oracle-renamed'
      })
      await run.oracle.step('CLI rename', { worktreeId, panesPerTab: [1, 1] })
      await run.client.call('terminal.close', { terminal: created.handle })
      await run.oracle.step('CLI close', {
        worktreeId,
        panesPerTab: [1],
        removed: [created.leafId]
      })
    }
  },
  {
    // The paired-client tab commands: create a terminal tab, split it into a new group, close it.
    id: 'client-create-split-close',
    journey: async (run, worktreeId) => {
      const worktree = `id:${worktreeId}`
      const created = await run.client.call<{ tab: { parentTabId: string } }>(
        'session.tabs.createTerminal',
        { worktree }
      )
      const tabId = created.result.tab.parentTabId
      await run.oracle.step('client creates tab', { worktreeId, panesPerTab: [1, 1] })
      const tabs = await run.client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
        worktree
      })
      await run.client.call('session.tabs.move', {
        worktree,
        tabId,
        targetGroupId: tabs.result.tabGroups![0]!.id,
        kind: 'split',
        splitDirection: 'right'
      })
      await run.oracle.step('client moves tab to a new group', { worktreeId, panesPerTab: [1, 1] })
      await run.client.call('session.tabs.close', { worktree, tabId, reason: 'user' })
      await run.oracle.step('client closes tab', { worktreeId, panesPerTab: [1], removed: 1 })
    }
  },
  {
    // The CLI and a phone move the host window ('host' navigation); the layout must not change.
    id: 'host-navigation',
    // It ends on an editor tab, so its markers are checked while a terminal is shown.
    endMarkers: false,
    journey: async (run, worktreeId) => {
      await newTabFromMenu(run.page)
      await run.oracle.step('new tab', { worktreeId, panesPerTab: [1, 1] })
      const first = (await listTerminals(run, worktreeId))[0]!
      await run.client.call('terminal.focus', { terminal: first.handle, navigation: 'host' })
      await expect(
        run.page.locator(`${SORTABLE_TAB}[data-tab-id="${first.tabId}"][data-active="true"]`)
      ).toHaveCount(1)
      await run.oracle.step('CLI focuses the first tab', { worktreeId, panesPerTab: [1, 1] })
      await run.oracle.checkMarkers('first tab shown', worktreeId)
      await run.client.call('files.open', {
        worktree: `id:${worktreeId}`,
        relativePath: 'README.md',
        navigation: 'host'
      })
      await expect(
        run.page.locator('[data-tab-group-strip-id]').getByText('README.md').first()
      ).toBeVisible()
      await run.oracle.step('CLI opens a file', { worktreeId, panesPerTab: [1, 1] })
    }
  },
  {
    // A reloaded window republishes its graph, which is what the phone's tab list is built from.
    id: 'window-reload',
    journey: async (run, worktreeId) => {
      await splitActiveTerminalPane(run.page, 'vertical')
      await waitForBoundPanes(run.page, 2)
      await run.oracle.step('split', { worktreeId, panesPerTab: [2] })
      await run.reloadWindow()
      await waitForActiveTerminalManager(run.page)
      await waitForBoundPanes(run.page, 2).catch(() => {})
      await run.oracle.step(
        'after window reload',
        { worktreeId, panesPerTab: [2] },
        { allowRemount: true }
      )
    }
  },
  {
    // Quit straight after a gesture: only the quit-time save can carry it.
    id: 'quit-right-after-change',
    journey: async (run, worktreeId) => {
      await splitActiveTerminalPane(run.page, 'vertical')
      await run.relaunch({
        worktreeId,
        paneCount: 2,
        panesPerTab: [2],
        quitWithoutSettling: true,
        reopen: reopenActiveWorktree
      })
    }
  },
  {
    // An older phone build sends a whole pane tree; a stale one must not drop a live pane.
    id: 'old-client-pane-tree',
    journey: async (run, worktreeId) => {
      const handle = await firstHandle(run, worktreeId)
      await run.client.call('terminal.split', { terminal: handle, direction: 'vertical' })
      await waitForBoundPanes(run.page, 2)
      await run.oracle.step('split', { worktreeId, panesPerTab: [2] })
      const [first] = await listTerminals(run, worktreeId)
      await run.client
        .call('session.tabs.updatePaneLayout', {
          worktree: `id:${worktreeId}`,
          tabId: first!.tabId,
          root: { type: 'leaf', leafId: first!.leafId }
        })
        .catch(() => {})
      await run.oracle.step('stale pane tree from an old client', { worktreeId, panesPerTab: [2] })
    }
  },
  {
    id: 'restart-restore',
    journey: async (run, worktreeId) => {
      await splitActiveTerminalPane(run.page, 'vertical')
      await waitForBoundPanes(run.page, 2)
      await newTabFromMenu(run.page)
      await run.oracle.step('split and new tab', { worktreeId, panesPerTab: [2, 1] })
      await run.relaunch({ worktreeId, paneCount: 1, panesPerTab: [2, 1] })
      await run.oracle.checkMarkers('after relaunch', worktreeId)
    }
  },
  {
    id: 'cold-daemon-restart',
    journey: async (run, worktreeId) => {
      await splitActiveTerminalPane(run.page, 'vertical')
      await waitForBoundPanes(run.page, 2)
      await newTabFromMenu(run.page)
      await run.oracle.step('split and new tab', { worktreeId, panesPerTab: [2, 1] })
      await run.relaunch({ worktreeId, paneCount: 1, coldDaemon: true, panesPerTab: [2, 1] })
      await run.oracle.checkMarkers('after cold relaunch', worktreeId)
    }
  },
  {
    // The in-app "restart terminal daemon" action, with the window open.
    id: 'live-daemon-restart',
    journey: async (run, worktreeId) => {
      await splitActiveTerminalPane(run.page, 'vertical')
      await waitForBoundPanes(run.page, 2)
      const before = await run.oracle.step('split', { worktreeId, panesPerTab: [2] })
      run.oracle.rememberForRestart(before)
      await run.page.evaluate(() => window.api.pty.management.restart())
      await waitForBoundPanes(run.page, 2).catch(() => {})
      const after = await run.oracle.step(
        'daemon restarted',
        { worktreeId, panesPerTab: [2], terminalsRestart: true },
        { allowRemount: true }
      )
      run.oracle.compareRestart('daemon restart', after, { maskPtyIds: true })
      await run.oracle.checkMarkers('after daemon restart', worktreeId)
      // What the user gets back after the next relaunch is the layout that survived.
      await run.relaunch({ worktreeId, paneCount: 2, panesPerTab: [2] })
    }
  },
  {
    id: 'folder-workspace',
    setup: async (run) => addFolderWorkspace(run.page),
    journey: async (run, worktreeId) => {
      await splitActiveTerminalPane(run.page, 'vertical')
      await waitForBoundPanes(run.page, 2)
      await newTabFromMenu(run.page)
      await run.oracle.step('split and new tab', { worktreeId, panesPerTab: [2, 1] })
    }
  },
  {
    // STA-9417: the CLI creates a worktree whose setup script runs in a split; first activation.
    id: 'setup-split-first-activation',
    // Its own worktree's panes are checked in the journey; the seeded one is no longer shown.
    endMarkers: false,
    setup: async (run) => addHostCreatedSetupSplitWorktree(run.page, run.userDataDir),
    journey: async (run) => {
      const setupWorktreeId = await openSetupSplitWorktree(run.page, run.userDataDir)
      run.worktreeIds.push(setupWorktreeId)
      await run.oracle.step('open setup worktree', {
        worktreeId: setupWorktreeId,
        panesPerTab: [2]
      })
      await run.oracle.checkMarkers('setup worktree', setupWorktreeId)
    }
  },
  {
    id: 'sleep-quit-resume',
    endMarkers: false,
    journey: async (run, worktreeId) => {
      await sleepAgentPane(run.page, worktreeId)
      await run.oracle.step('sleep agent pane', { worktreeId, panesPerTab: [2] })
      await run.relaunch({
        worktreeId,
        paneCount: 2,
        panesPerTab: [2],
        terminalsRestart: true,
        reopen: wakeByClick
      })
    }
  }
]

const REPEAT = Math.max(1, Number(process.env.ORCA_LAYOUT_ORACLE_REPEAT ?? 1))
const RECORD_ONLY = process.env.ORCA_LAYOUT_ORACLE_RECORD === '1'

for (const scenario of SCENARIOS) {
  for (let attempt = 1; attempt <= REPEAT; attempt += 1) {
    const suffix = REPEAT > 1 ? ` #${attempt}` : ''
    // oxlint-disable-next-line no-empty-pattern -- Each scenario owns its launches.
    test(`layout oracle: ${scenario.id}${suffix}`, async ({}, testInfo) => {
      const repoPath = seededRepoPathOrSkip()
      const findings = await runOracleScenario(testInfo, scenario.id, async (run) => {
        let cleanup: (() => void) | undefined
        try {
          let worktreeId: string
          if (scenario.setup) {
            const setup = await scenario.setup(run)
            worktreeId = setup.worktreeId
            cleanup = setup.cleanup
          } else {
            worktreeId = (await bootstrapFirstLaunch(run.page, repoPath)).worktreeId
          }
          run.worktreeIds.push(worktreeId)
          await waitForBoundPanes(run.page, 1)
          await run.oracle.step('start', { worktreeId, panesPerTab: [1] })
          await scenario.journey(run, worktreeId)
          if (scenario.endMarkers !== false) {
            await run.oracle.checkMarkers('end', worktreeId)
          }
        } finally {
          cleanup?.()
        }
      })
      for (const finding of findings) {
        console.log(
          `[layout-oracle] ${scenario.id}: ${finding.check} @ ${finding.step}\n  ${finding.details.join('\n  ')}`
        )
      }
      if (!RECORD_ONLY) {
        expect(unexpectedFindings(scenario.id, findings)).toEqual([])
      }
    })
  }
}
