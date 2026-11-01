import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import { waitForRestoredTerminalInputReady } from './helpers/restored-terminal-input-readiness'
import { worktreeRow } from './worktree-row-locators'

// Use real PTY OSC titles to retain hookless Cursor’s literal cursor agent (#10258) and keep OpenCode ownership when its task merely mentions claude (#8940).

// The literal Cursor emits on every redraw — the pane's ONLY identity signal.
const CURSOR_NATIVE_OSC_TITLE = 'Cursor Agent'
// An OpenCode task title that merely MENTIONS claude (see #8940).
const OPENCODE_TASK_OSC_TITLE = '⠋ use Claude Sonnet'

/** Printed banner that proves the emitter ran; the OSC title trails it in the same chunk. */
const PANE_HOLD_MARKER = 'agent pane holding'

// Keep the emitter alive so shell prompts cannot overwrite identity; emit in one chunk to avoid a title-less stale-title probe.
function oscTitleHolderScript(escapedTitle: string): string {
  return [
    `process.stdout.write('${PANE_HOLD_MARKER}\\r\\n\\u001b]0;${escapedTitle}\\u0007')`,
    'setInterval(() => {}, 1e9)',
    ''
  ].join('\n')
}

async function useFullAgentActivityRows(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    // Render full rows so assertions read labels/icons instead of summary pills.
    state.setAgentActivityDisplayMode('full')
    if (!state.worktreeCardProperties.includes('inline-agents')) {
      state.setWorktreeCardProperties([...state.worktreeCardProperties, 'inline-agents'])
    }
  })
}

function paneTitles(page: Page, tabId: string): Promise<string[]> {
  return page.evaluate((tabId) => {
    const byPane = window.__store?.getState().runtimePaneTitlesByTabId?.[tabId] ?? {}
    return Object.values(byPane).filter((title): title is string => typeof title === 'string')
  }, tabId)
}

// Launch through the tab-bar agent path and prove shell echo before sending the emitter command.
async function openAgentTab(
  page: Page,
  worktreeId: string,
  launchAgent: 'cursor' | 'opencode'
): Promise<{ tabId: string; ptyId: string }> {
  const tabId = await page.evaluate(
    ({ worktreeId, launchAgent }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const tab = state.createTab(worktreeId, undefined, undefined, {
        launchAgent
      })
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal', store.getState().activeWorktreeId)
      return tab.id
    },
    { worktreeId, launchAgent }
  )
  await waitForActiveTerminalManager(page)
  // Allow cold-app PTY binding beyond the default 15s.
  const ptyId = await waitForActivePanePtyId(page, 45_000)
  expect(
    await waitForRestoredTerminalInputReady(page, ptyId, 20_000),
    `the shell in the ${launchAgent} tab never echoed a probe command`
  ).toBe(true)
  return { tabId, ptyId }
}

// Read rendered icon tooltips in one evaluate so rerender cannot split the snapshot.
function sidebarAgentRowIdentities(page: Page, agentListSelector: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const list = document.querySelector(selector)
    return list
      ? [...list.children]
          .map((row) => row.querySelector('span[title]')?.getAttribute('title') ?? '')
          .filter((identity) => identity.length > 0)
          .sort()
      : []
  }, agentListSelector)
}

// Return one settled identity snapshot for readable assertions.
async function settledSidebarAgentRowIdentities(
  page: Page,
  agentListSelector: string
): Promise<string[]> {
  const requiredStableReads = 4
  let previousKey = ''
  let stableReads = 0
  let settled: string[] = []
  await expect
    .poll(
      async () => {
        settled = await sidebarAgentRowIdentities(page, agentListSelector)
        const key = JSON.stringify(settled)
        stableReads = key === previousKey && settled.length > 0 ? stableReads + 1 : 0
        previousKey = key
        return stableReads >= requiredStableReads
      },
      {
        timeout: 20_000,
        intervals: [200],
        message: 'the sidebar agent rows never settled on a stable set'
      }
    )
    .toBe(true)
  return settled
}

test('sidebar keeps a Cursor pane visible and an OpenCode pane out of Claude Code hands', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await useFullAgentActivityRows(orcaPage)

  const openCode = await openAgentTab(orcaPage, worktreeId, 'opencode')
  const openCodeScript = await runNodeScriptInTerminal(
    orcaPage,
    openCode.ptyId,
    // ⠋ is the braille spinner frame OpenCode paints ahead of its task text.
    oscTitleHolderScript('\\u280b use Claude Sonnet')
  )
  await waitForTerminalOutput(orcaPage, PANE_HOLD_MARKER, 15_000)
  // Require the always-accepted title as a PTY emission precondition.
  await expect
    .poll(() => paneTitles(orcaPage, openCode.tabId), {
      timeout: 15_000,
      message: 'the OpenCode task title never reached the renderer'
    })
    .toContain(OPENCODE_TASK_OSC_TITLE)

  const cursor = await openAgentTab(orcaPage, worktreeId, 'cursor')
  const cursorScript = await runNodeScriptInTerminal(
    orcaPage,
    cursor.ptyId,
    oscTitleHolderScript(CURSOR_NATIVE_OSC_TITLE)
  )
  // Require emitter output before judging literal-title filtering.
  await waitForTerminalOutput(orcaPage, PANE_HOLD_MARKER, 15_000)

  // Only the active worktree's card has agents, so this resolves to one list.
  const agentListSelector = `[data-worktree-sidebar] [aria-label="Agents"]`
  const agentList = worktreeRow(orcaPage, worktreeId).locator('[aria-label="Agents"]')
  await expect(agentList.locator('> div').first()).toBeVisible()

  expect(await settledSidebarAgentRowIdentities(orcaPage, agentListSelector)).toEqual([
    'Cursor',
    'OpenCode'
  ])

  await expect(agentList.locator('> div')).toHaveCount(2)
  await expect(agentList).toContainText('Cursor')
  await expect(agentList).toContainText('use Claude Sonnet')

  openCodeScript.cleanup()
  cursorScript.cleanup()
})
