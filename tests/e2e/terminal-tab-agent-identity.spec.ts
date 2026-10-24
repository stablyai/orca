import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import { waitForRestoredTerminalInputReady } from './helpers/restored-terminal-input-readiness'

const CLAUDE_IDENTITY_OSC_TITLE = '✳ Claude Code'
const CLAUDE_IDENTITY_MARKER = 'claude identity seeded'
const CLAUDE_TASK_OSC_TITLE = '⠋ Fix the codex plugin launcher'
const PANE_HOLD_MARKER = 'claude pane holding'

// Seed Claude identity before the Codex mention so the test evaluates title re-ownership.
function oscTitleHolderScript(): string {
  return [
    `const readline = require('node:readline')`,
    `process.stdout.write('\\u001b]0;\\u2733 Claude Code\\u0007')`,
    `process.stdout.write('${CLAUDE_IDENTITY_MARKER}\\r\\n')`,
    `readline.createInterface({ input: process.stdin }).once('line', () => {`,
    `  process.stdout.write('${PANE_HOLD_MARKER}\\r\\n\\u001b]0;\\u280b Fix the codex plugin launcher\\u0007')`,
    `})`,
    'setInterval(() => {}, 1e9)',
    ''
  ].join('\n')
}

function paneTitles(page: Page, tabId: string): Promise<string[]> {
  return page.evaluate((tabId) => {
    const byPane = window.__store?.getState().runtimePaneTitlesByTabId?.[tabId] ?? {}
    return Object.values(byPane).filter((title): title is string => typeof title === 'string')
  }, tabId)
}

async function openClaudeTab(
  page: Page,
  worktreeId: string
): Promise<{ tabId: string; ptyId: string }> {
  const tabId = await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const tab = state.createTab(worktreeId, undefined, undefined, { launchAgent: 'claude' })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return tab.id
  }, worktreeId)
  await waitForActiveTerminalManager(page)
  const ptyId = await waitForActivePanePtyId(page, 45_000)
  expect(await waitForRestoredTerminalInputReady(page, ptyId, 20_000)).toBe(true)
  return { tabId, ptyId }
}

test('Claude task titles that mention Codex keep the Claude tab icon', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const claude = await openClaudeTab(orcaPage, worktreeId)
  const claudeScript = await runNodeScriptInTerminal(orcaPage, claude.ptyId, oscTitleHolderScript())

  try {
    await waitForTerminalOutput(orcaPage, CLAUDE_IDENTITY_MARKER, 15_000)
    await expect
      .poll(() => paneTitles(orcaPage, claude.tabId), {
        timeout: 15_000,
        message: 'the Claude identity title never reached the renderer'
      })
      .toContain(CLAUDE_IDENTITY_OSC_TITLE)

    await sendToTerminal(orcaPage, claude.ptyId, '\r')
    await waitForTerminalOutput(orcaPage, PANE_HOLD_MARKER, 15_000)
    await expect
      .poll(() => paneTitles(orcaPage, claude.tabId), {
        timeout: 15_000,
        message: 'the Claude task title never reached the renderer'
      })
      .toContain(CLAUDE_TASK_OSC_TITLE)

    const claudeTab = orcaPage.locator(`[data-tab-id="${claude.tabId}"]`)
    await expect(claudeTab.locator('[data-agent-icon="claude"]')).toBeVisible()
    await expect(claudeTab.locator('[data-agent-icon="codex"]')).toHaveCount(0)
  } finally {
    claudeScript.cleanup()
  }
})
