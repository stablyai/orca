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

/**
 * Sidebar agent-row identity, driven by real OSC titles on real PTYs.
 *
 * #10258 — Cursor's only native OSC title is the literal `cursor agent`; it was
 * dropped unconditionally, so a hookless Cursor pane produced no sidebar row.
 * #8940 — an incidental `claude` token inside an OpenCode task title outranked
 * the pane's known owner, flipping the row label + identity icon to Claude Code.
 */

// The literal Cursor emits on every redraw — the pane's ONLY identity signal.
const CURSOR_NATIVE_OSC_TITLE = 'Cursor Agent'
// An OpenCode task title that merely MENTIONS claude (see #8940).
const OPENCODE_TASK_OSC_TITLE = '⠋ use Claude Sonnet'

/** Printed banner that proves the emitter ran; the OSC title trails it in the same chunk. */
const PANE_HOLD_MARKER = 'agent pane holding'

// Why: the emitter must never exit — a returning shell prompt would repaint its own
// cwd title over the agent title, which a real TUI holding the pane never allows.
// Why one write: a later title-less chunk arms the stale-title probe, which strips
// the working frame the row depends on.
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
    // Why: 'full' renders every agent row with its label inline, so the proof
    // reads off the rendered sidebar instead of a collapsed summary pill.
    state.setAgentActivityDisplayMode('full')
    if (!state.worktreeCardProperties.includes('inline-agents')) {
      state.toggleWorktreeCardProperty('inline-agents')
    }
  })
}

function paneTitles(page: Page, tabId: string): Promise<string[]> {
  return page.evaluate((tabId) => {
    const byPane = window.__store?.getState().runtimePaneTitlesByTabId?.[tabId] ?? {}
    return Object.values(byPane).filter((title): title is string => typeof title === 'string')
  }, tabId)
}

/**
 * Opens a terminal tab launched as `launchAgent`, exactly like the tab-bar quick
 * launch, and proves the shell round-trips a command before returning — a cold
 * PTY silently swallows the emitter command otherwise.
 */
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
      state.setActiveTabType('terminal')
      return tab.id
    },
    { worktreeId, launchAgent }
  )
  await waitForActiveTerminalManager(page)
  // Why the raised budget: the first tab of a cold app can bind its PTY well past
  // the helper's 15s default on a loaded machine.
  const ptyId = await waitForActivePanePtyId(page, 45_000)
  expect(
    await waitForRestoredTerminalInputReady(page, ptyId, 20_000),
    `the shell in the ${launchAgent} tab never echoed a probe command`
  ).toBe(true)
  return { tabId, ptyId }
}

/**
 * Identity of each rendered sidebar agent row, read off the row's identity icon
 * tooltip (the first titled span in the row) — i.e. the glyph the user sees.
 * Read in one evaluate so a sidebar re-render cannot split the snapshot.
 */
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

/**
 * Waits for the rendered row identities to hold still, then returns them, so the
 * claim below is asserted against one settled snapshot with a readable diff.
 */
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
  // Precondition, not the claim under test: this title is filtered on neither
  // branch, so a failure here means the PTY never emitted it.
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
  // Settle gate: the emitter has run, so the literal has been offered to the title
  // pipeline — kept as Cursor identity on the fix, dropped on main.
  await waitForTerminalOutput(orcaPage, PANE_HOLD_MARKER, 15_000)

  // Only the active worktree's card has agents, so this resolves to one list.
  const agentListSelector = `[data-worktree-sidebar] [aria-label="Agents"]`
  const agentList = worktreeRow(orcaPage, worktreeId).locator('[aria-label="Agents"]')
  await expect(agentList.locator('> div').first()).toBeVisible()

  // #10258: the Cursor pane gets a row at all. #8940: the OpenCode pane stays OpenCode.
  expect(await settledSidebarAgentRowIdentities(orcaPage, agentListSelector)).toEqual([
    'Cursor',
    'OpenCode'
  ])

  // Both panes are on the card: the Cursor row exists at all (#10258) next to the
  // OpenCode row still labelled by its own task text (#8940).
  await expect(agentList.locator('> div')).toHaveCount(2)
  await expect(agentList).toContainText('Cursor')
  await expect(agentList).toContainText('use Claude Sonnet')

  openCodeScript.cleanup()
  cursorScript.cleanup()
})
