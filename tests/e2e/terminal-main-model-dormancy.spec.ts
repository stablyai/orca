import type { Page } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { test, expect } from './helpers/orca-app'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot,
  waitForTerminalOutput
} from './helpers/terminal'
import { MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS } from '../../src/main/runtime/main-terminal-model-dormancy'

// Main stops parsing a visible local terminal nobody reads through main
// (#27023) and rebuilds its model from the daemon when the pane is hidden.
// The user-visible contract must not change: the hidden pane's queries are
// still answered at the right cursor position, and the reveal shows every
// byte with the scrollback the pane had.

const VISIBLE_LINES = 3_000
const HIDDEN_LINES = 400
const HIDDEN_START_DELAY_MS = 2_500
const CONTENT_CHAR_LIMIT = 2_000_000

function visibleFloodScript(runId: string): string {
  return `
for (let i = 0; i < ${VISIBLE_LINES}; i++) process.stdout.write('VISIBLE_LINE_${runId}_' + i + '\\r\\n')
process.stdout.write('VISIBLE_DONE_${runId}\\r\\n')
`
}

// Why a CPR at the end: its reply depends on the cursor, so only an exact rebuilt
// model answers BOTTOM; a stale or missing model answers wrong or not at all.
function hiddenQueryScript(runId: string): string {
  return `
setTimeout(() => {
  for (let i = 0; i < ${HIDDEN_LINES}; i++) process.stdout.write('HIDDEN_LINE_${runId}_' + i + '\\r\\n')
  const rows = process.stdout.rows
  let reply = ''
  const timer = setTimeout(() => {
    process.stdout.write('CPR_TIMEOUT_${runId}\\r\\n')
    process.exit(0)
  }, 5000)
  process.stdin.setRawMode(true)
  process.stdin.on('data', (chunk) => {
    reply += chunk.toString('latin1')
    const match = /\\x1b\\[(\\d+);(\\d+)R/.exec(reply)
    if (!match) return
    clearTimeout(timer)
    process.stdin.setRawMode(false)
    const where = Number(match[1]) === rows ? 'BOTTOM' : 'ROW' + match[1] + 'OF' + rows
    process.stdout.write('CPR_${runId}_' + where + '\\r\\n')
    process.exit(0)
  })
  process.stdout.write('\\x1b[6n')
}, ${HIDDEN_START_DELAY_MS})
`
}

const QUERY_ROUNDS = 60
const QUERY_ROUND_INTERVAL_MS = 40

// Why rounds of CPR, DA1 and DSR 5n straddling the hide and the reveal: a moment with no
// responder or two shows up as a missing or extra reply, and the fixed cursor makes a stale
// responder's CPR detectable.
function queryRoundsScript(runId: string, floodLinesPerRound: number): string {
  return `
const filler = 'F'.repeat(100) + '\\r\\n'
let input = ''
process.stdin.setRawMode(true)
process.stdin.on('data', (chunk) => {
  input += chunk.toString('latin1')
})
setTimeout(() => {
  process.stdout.write('QR_START_${runId}\\r\\n')
  let round = 0
  const timer = setInterval(() => {
    process.stdout.write(filler.repeat(${floodLinesPerRound}) + '\\x1b[3;5H\\x1b[6n\\x1b[c\\x1b[5n')
    round += 1
    if (round < ${QUERY_ROUNDS}) return
    clearInterval(timer)
    setTimeout(() => {
      process.stdin.setRawMode(false)
      const cpr = [...input.matchAll(/\\x1b\\[(\\d+);(\\d+)R/g)]
      const bad = cpr.filter((match) => match[1] !== '3' || match[2] !== '5').length
      const da = (input.match(/\\x1b\\[\\?[\\d;]*c/g) ?? []).length
      const dsr = (input.match(/\\x1b\\[0n/g) ?? []).length
      process.stdout.write('\\x1b[999;1H\\r\\nQR_${runId}_CPR' + cpr.length + '_BAD' + bad + '_DA' + da + '_DSR' + dsr + '_END\\r\\n')
      process.exit(0)
    }, 1500)
  }, ${QUERY_ROUND_INTERVAL_MS})
}, 1000)
`
}

// Why count replies: with the daemon answering a hidden pane, a second responder would show up
// as a second CPR; the cursor row proves the daemon's model is exact.
function hiddenDaemonQueryScript(runId: string, startDelayMs: number): string {
  return `
setTimeout(() => {
  for (let i = 0; i < ${HIDDEN_LINES}; i++) process.stdout.write('DAEMON_LINE_${runId}_' + i + '\\r\\n')
  const rows = process.stdout.rows
  let reply = ''
  process.stdin.setRawMode(true)
  process.stdin.on('data', (chunk) => {
    reply += chunk.toString('latin1')
  })
  process.stdout.write('\\x1b[6n')
  setTimeout(() => {
    process.stdin.setRawMode(false)
    const replies = [...reply.matchAll(/\\x1b\\[(\\d+);(\\d+)R/g)]
    const where = replies.length && Number(replies[0][1]) === rows ? 'BOTTOM' : 'WRONG'
    process.stdout.write('DCPR_${runId}_' + where + '_COUNT' + replies.length + '\\r\\n')
    process.exit(0)
  }, 1500)
}, ${startDelayMs})
`
}

async function daemonQueryResponderPtyCount(page: Page): Promise<number> {
  return page.evaluate(
    async () =>
      (await window.api.pty.getRendererDeliveryDebugSnapshot()).daemonQueryResponderPtyCount
  )
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((targetTabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('activateTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
    state.setActiveTab(targetTabId)
  }, tabId)
  await expect.poll(() => getActiveTabId(page), { timeout: 5_000 }).toBe(tabId)
}

async function createActiveTerminalTab(page: Page, worktreeId: string): Promise<string> {
  const tabId = await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('createActiveTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    const tab = state.createTab(id, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
    return tab.id
  }, worktreeId)
  await expect.poll(() => getActiveTabId(page), { timeout: 5_000 }).toBe(tabId)
  await waitForActiveTerminalManager(page, 30_000)
  return tabId
}

test.describe('Main terminal model dormancy', () => {
  test('a visible terminal main stopped parsing answers queries while hidden and reveals intact', async ({
    orcaPage
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneIdentitySnapshot(orcaPage, 1)
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const tabId = (await getActiveTabId(orcaPage))!
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID().slice(0, 8)

    // Why the wait: main drops its model only after a quiet grace period.
    await orcaPage.waitForTimeout(MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS + 1_000)
    const flood = await runNodeScriptInTerminal(orcaPage, ptyId, visibleFloodScript(runId))
    await waitForTerminalOutput(orcaPage, `VISIBLE_DONE_${runId}`, 60_000)
    flood.cleanup()

    const hidden = await runNodeScriptInTerminal(orcaPage, ptyId, hiddenQueryScript(runId))
    await createActiveTerminalTab(orcaPage, worktreeId)
    // Why: the script prints and queries only after the pane is hidden.
    await orcaPage.waitForTimeout(HIDDEN_START_DELAY_MS + 3_000)

    await activateTerminalTab(orcaPage, tabId)
    await waitForTerminalOutput(orcaPage, `CPR_${runId}_`, 30_000, CONTENT_CHAR_LIMIT)
    hidden.cleanup()
    const content = await orcaPage.evaluate(
      ({ id, limit }) => {
        const pane = window.__paneManagers?.get(id)?.getActivePane?.()
        return pane?.serializeAddon?.serialize?.()?.slice(-limit) ?? ''
      },
      { id: tabId, limit: CONTENT_CHAR_LIMIT }
    )
    expect(content).toContain(`CPR_${runId}_BOTTOM`)
    expect(content).not.toContain(`CPR_TIMEOUT_${runId}`)
    expect(content).toContain(`HIDDEN_LINE_${runId}_${HIDDEN_LINES - 1}`)
    expect(content).toContain(`VISIBLE_DONE_${runId}`)
    // Why line 0: the reveal must keep the scrollback the visible flood built.
    expect(content).toContain(`VISIBLE_LINE_${runId}_0\r`)
    const hiddenLines = content.match(new RegExp(`HIDDEN_LINE_${runId}_\\d+`, 'g')) ?? []
    expect(hiddenLines).toHaveLength(HIDDEN_LINES)
  })

  for (const [name, floodLinesPerRound, daemonAnswers] of [
    ['quiet', 0, true],
    ['with output in flight', 200, true],
    ['quiet, main answers', 0, false],
    ['with output in flight, main answers', 200, false]
  ] as const) {
    test(`a dormant pane hidden and revealed mid-query answers each query exactly once (${name})`, async ({
      orcaPage
    }) => {
      if (!daemonAnswers) {
        await orcaPage.evaluate(() =>
          window.api.settings.set({ terminalDaemonQueryAuthority: false })
        )
      }
      test.setTimeout(180_000)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await waitForPaneIdentitySnapshot(orcaPage, 1)
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const tabId = (await getActiveTabId(orcaPage))!
      const ptyId = await waitForActivePanePtyId(orcaPage)
      const runId = randomUUID().slice(0, 8)

      // Why the wait: main drops its model only after a quiet grace period, so the hide
      // below opens the handoff.
      await orcaPage.waitForTimeout(MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS + 1_000)
      const script = await runNodeScriptInTerminal(
        orcaPage,
        ptyId,
        queryRoundsScript(runId, floodLinesPerRound)
      )
      await waitForTerminalOutput(orcaPage, `QR_START_${runId}`, 30_000, CONTENT_CHAR_LIMIT)
      await orcaPage.waitForTimeout(QUERY_ROUND_INTERVAL_MS * 8)
      await createActiveTerminalTab(orcaPage, worktreeId)
      await orcaPage.waitForTimeout(QUERY_ROUND_INTERVAL_MS * 25)
      await activateTerminalTab(orcaPage, tabId)

      await waitForTerminalOutput(orcaPage, `QR_${runId}_CPR`, 30_000, CONTENT_CHAR_LIMIT)
      script.cleanup()
      const content = await orcaPage.evaluate(
        ({ id, limit }) => {
          const pane = window.__paneManagers?.get(id)?.getActivePane?.()
          return pane?.serializeAddon?.serialize?.()?.slice(-limit) ?? ''
        },
        { id: tabId, limit: CONTENT_CHAR_LIMIT }
      )
      const n = QUERY_ROUNDS
      expect(content).toContain(`QR_${runId}_CPR${n}_BAD0_DA${n}_DSR${n}_END`)
    })
  }

  test('a hidden terminal whose queries the daemon answers replies once and reveals intact', async ({
    orcaPage
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneIdentitySnapshot(orcaPage, 1)
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const tabId = (await getActiveTabId(orcaPage))!
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID().slice(0, 8)
    // Why past the grace period: main's model goes dormant while the daemon answers.
    const startDelayMs = MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS + 2_500

    const hidden = await runNodeScriptInTerminal(
      orcaPage,
      ptyId,
      hiddenDaemonQueryScript(runId, startDelayMs)
    )
    const coverTabId = await createActiveTerminalTab(orcaPage, worktreeId)
    await expect.poll(() => daemonQueryResponderPtyCount(orcaPage), { timeout: 10_000 }).toBe(1)
    await orcaPage.waitForTimeout(startDelayMs + 2_500)

    await activateTerminalTab(orcaPage, tabId)
    await waitForTerminalOutput(orcaPage, `DCPR_${runId}_`, 30_000, CONTENT_CHAR_LIMIT)
    hidden.cleanup()
    // Why close the cover tab: it is hidden now, so the daemon may answer for it instead.
    await orcaPage.evaluate((id) => window.__store?.getState().closeTab(id), coverTabId)
    await expect.poll(() => daemonQueryResponderPtyCount(orcaPage), { timeout: 10_000 }).toBe(0)
    const content = await orcaPage.evaluate(
      ({ id, limit }) => {
        const pane = window.__paneManagers?.get(id)?.getActivePane?.()
        return pane?.serializeAddon?.serialize?.()?.slice(-limit) ?? ''
      },
      { id: tabId, limit: CONTENT_CHAR_LIMIT }
    )
    expect(content).toContain(`DCPR_${runId}_BOTTOM_COUNT1`)
    const hiddenLines = content.match(new RegExp(`DAEMON_LINE_${runId}_\\d+`, 'g')) ?? []
    expect(hiddenLines).toHaveLength(HIDDEN_LINES)
  })
})
