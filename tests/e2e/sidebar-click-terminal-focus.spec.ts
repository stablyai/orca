// STA-15458 / STA-15415: a sidebar click must hand keys to the opened terminal; the delete shortcut stays list-scoped.
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { orcaCliResult } from './helpers/compiled-orca-cli'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import { waitForRestoredTerminalInputReady } from './helpers/restored-terminal-input-readiness'
import { pressShortcut } from './helpers/shortcuts'
import { worktreeRow, worktreeRowSurface } from './worktree-row-locators'

const AGENT_INPUT_ECHO = 'agent got:'

async function prepareTwoTerminals(page: Page): Promise<{ source: string; target: string }> {
  await waitForSessionReady(page)
  const source = await waitForActiveWorktree(page)
  const target = (await getAllWorktreeIds(page)).find((id) => id !== source)
  if (!target) {
    throw new Error('Expected a second seeded workspace')
  }
  for (const id of [target, source]) {
    await switchToWorktree(page, id)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page)
    await waitForActivePanePtyId(page)
  }
  return { source, target }
}

function visibleTerminalInput(page: Page) {
  return page.locator('[data-terminal-tab-id]:visible .xterm-helper-textarea').first()
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const proofPath = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: proofPath })
  await testInfo.attach(name, { path: proofPath, contentType: 'image/png' })
}

// Typing proves delivery: the marker reaches the terminal only if its textarea owns the keys.
async function expectTypingReachesTerminal(
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  const marker = `KEYS_${name.toUpperCase().replaceAll('-', '_')}`
  try {
    await expect(visibleTerminalInput(page)).toBeFocused()
    await page.keyboard.type(`echo ${marker}`)
    await waitForTerminalOutput(page, marker)
  } finally {
    // Taken either way so a run without the fix records where the keys went.
    await shot(page, testInfo, name)
  }
}

async function expectActiveId(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().activeWorktreeId))
    .toBe(worktreeId)
}

async function expectActive(page: Page, worktreeId: string): Promise<void> {
  await expectActiveId(page, worktreeId)
  await waitForActiveTerminalManager(page)
}

test.describe('Sidebar click terminal focus', () => {
  test('a plain row click puts typing in the opened terminal', async ({ orcaPage }, testInfo) => {
    const { target } = await prepareTwoTerminals(orcaPage)
    await worktreeRowSurface(orcaPage, target).click()
    await expectActive(orcaPage, target)
    await expectTypingReachesTerminal(orcaPage, testInfo, 'plain-click')
    // Re-clicking the open workspace activates nothing; the click alone must hand the keys back.
    await worktreeRowSurface(orcaPage, target).click()
    await expectTypingReachesTerminal(orcaPage, testInfo, 'active-row-click')
  })

  test('a plain click after a modifier click puts typing in the terminal', async ({
    orcaPage
  }, testInfo) => {
    const { source, target } = await prepareTwoTerminals(orcaPage)
    await worktreeRowSurface(orcaPage, target).click({ modifiers: ['ControlOrMeta'] })
    await expect(orcaPage.locator('[data-worktree-sidebar]')).toBeFocused()
    expect(await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)).toBe(source)
    await worktreeRowSurface(orcaPage, target).click()
    await expectActive(orcaPage, target)
    await expectTypingReachesTerminal(orcaPage, testInfo, 'modifier-then-plain-click')
  })

  test('an agent row click puts typing in that agent pane', async ({ orcaPage }, testInfo) => {
    const { source, target } = await prepareTwoTerminals(orcaPage)
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      state.setAgentActivityDisplayMode('full')
      if (!state.worktreeCardProperties.includes('inline-agents')) {
        state.setWorktreeCardProperties([...state.worktreeCardProperties, 'inline-agents'])
      }
    })
    await switchToWorktree(orcaPage, target)
    await orcaPage.evaluate((worktreeId) => {
      const state = window.__store!.getState()
      const tab = state.createTab(worktreeId, undefined, undefined, { launchAgent: 'cursor' })
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal', worktreeId)
    }, target)
    await waitForActiveTerminalManager(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage, 45_000)
    expect(await waitForRestoredTerminalInputReady(orcaPage, ptyId, 20_000)).toBe(true)
    // The literal title is the pane's agent identity; echoing stdin proves where typed keys land.
    const script = await runNodeScriptInTerminal(
      orcaPage,
      ptyId,
      [
        "process.stdout.write('agent pane holding\\r\\n\\u001b]0;Cursor Agent\\u0007')",
        'process.stdin.setRawMode?.(true)',
        `process.stdin.on('data', (data) => process.stdout.write('${AGENT_INPUT_ECHO}' + data))`,
        ''
      ].join('\n')
    )
    try {
      await waitForTerminalOutput(orcaPage, 'agent pane holding', 15_000)
      const agentRow = worktreeRow(orcaPage, target).locator('[aria-label="Agents"] > div').first()
      await expect(agentRow).toBeVisible({ timeout: 20_000 })

      // A plain workspace click first: before the fix it parked keys in the list for every later click.
      await worktreeRowSurface(orcaPage, source).click()
      await expectActive(orcaPage, source)
      await agentRow.click()
      await expectActive(orcaPage, target)
      try {
        await expect(visibleTerminalInput(orcaPage)).toBeFocused()
        await orcaPage.keyboard.type('z')
        await waitForTerminalOutput(orcaPage, `${AGENT_INPUT_ECHO}z`)
      } finally {
        await shot(orcaPage, testInfo, 'agent-row-click')
      }
    } finally {
      script.cleanup()
    }
  })

  test('terminal switch from the CLI wins over sidebar list navigation', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    const { source, target } = await prepareTwoTerminals(orcaPage)
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const listed = await orcaCliResult<{ terminals: { handle: string; worktreeId: string }[] }>(
      userDataDir,
      ['terminal', 'list']
    )
    const handle = listed.terminals.find((terminal) => terminal.worktreeId === target)?.handle
    if (!handle) {
      throw new Error(`No terminal handle for ${target}: ${JSON.stringify(listed)}`)
    }
    // A modifier click is a deliberate list focus, the state that silently swallowed the switch.
    await worktreeRowSurface(orcaPage, source).click({ modifiers: ['ControlOrMeta'] })
    await expect(orcaPage.locator('[data-worktree-sidebar]')).toBeFocused()
    await orcaCliResult(userDataDir, ['terminal', 'switch', '--terminal', handle])
    await expectActive(orcaPage, target)
    await expectTypingReachesTerminal(orcaPage, testInfo, 'cli-terminal-switch')
  })

  test('the delete shortcut ignores a focused terminal and acts on a keyboard-selected row', async ({
    orcaPage
  }, testInfo) => {
    const { target } = await prepareTwoTerminals(orcaPage)
    // The primary checkout is never shortcut-deletable, so the keyboard target is a disposable worktree.
    const disposable = await orcaPage.evaluate(async (name) => {
      const state = window.__store!.getState()
      const repoId = state.getKnownWorktreeById(state.activeWorktreeId!)!.repoId
      const created = await state.createWorktree(repoId, name)
      await state.fetchWorktrees(repoId)
      return created.worktree.id
    }, `e2e-click-focus-delete-${Date.now()}`)
    try {
      await worktreeRowSurface(orcaPage, target).click()
      await expectActive(orcaPage, target)
      await expect(visibleTerminalInput(orcaPage)).toBeFocused()
      await pressShortcut(orcaPage, 'Backspace', { shift: true })
      // The dialog opens synchronously on keydown, so later terminal output proves none was coming.
      await orcaPage.keyboard.type('echo AFTER_DELETE_KEY')
      await waitForTerminalOutput(orcaPage, 'AFTER_DELETE_KEY')
      const dialog = orcaPage.getByRole('dialog')
      await expect(dialog).toHaveCount(0)
      await shot(orcaPage, testInfo, 'delete-from-terminal-ignored')

      await worktreeRowSurface(orcaPage, disposable).click()
      await expectActiveId(orcaPage, disposable)
      await pressShortcut(orcaPage, '0', { shift: true })
      const sidebar = orcaPage.locator('[data-worktree-sidebar]')
      await expect(sidebar).toBeFocused()
      // Arrow away and back so the deleted row is the one the keyboard selected.
      await orcaPage.keyboard.press('ArrowUp')
      await expect
        .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId))
        .not.toBe(disposable)
      await orcaPage.keyboard.press('ArrowDown')
      await expectActiveId(orcaPage, disposable)
      await expect(sidebar).toBeFocused()
      await pressShortcut(orcaPage, 'Backspace', { shift: true })
      await expect(dialog).toBeVisible()
      await shot(orcaPage, testInfo, 'delete-from-keyboard-selection')
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect
        .poll(() => getAllWorktreeIds(orcaPage), { timeout: 15_000 })
        .not.toContain(disposable)
      expect(await getAllWorktreeIds(orcaPage)).toContain(target)
    } finally {
      await orcaPage
        .evaluate(async (id) => {
          const state = window.__store?.getState()
          if (state?.getKnownWorktreeById(id)) {
            await state.removeWorktree({ id, executionHostId: null }, true)
          }
        }, disposable)
        .catch(() => undefined)
    }
  })
})
