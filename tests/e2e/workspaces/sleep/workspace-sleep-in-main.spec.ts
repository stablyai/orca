/**
 * Main runs a workspace's sleep and the window follows it: Sleep from the sidebar, a phone's
 * `worktree.sleep`, sleep then an immediate wake, and a delete during a sleep.
 */
import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'
import { waitForActivePanePtyId } from '../../terminal/input/terminal'
import {
  sendToTerminal,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from '../../terminal/layout/terminal-pane-operations'

type SleepState = {
  /** Terminals the window still binds; a sleep main ran leaves none. */
  windowLivePtys: number
  /** The tabs survive a sleep, so a wake reopens them. */
  tabs: number
  /** Main's own count, from a fresh liveness read. */
  hostLiveTerminals: number
}

function readSleepState(page: Page, worktreeId: string): Promise<SleepState> {
  return page.evaluate(async (id) => {
    const state = window.__store!.getState()
    const tabs = state.tabsByWorktree[id] ?? []
    const listed = await window.api.runtime.call({
      method: 'terminal.list',
      params: { worktree: `id:${id}`, requireFreshPtyLiveness: true }
    })
    // A liveness read can be briefly unavailable while terminals stop; the poll asks again.
    if (!listed.ok) {
      return { windowLivePtys: -1, tabs: -1, hostLiveTerminals: -1 }
    }
    const result = listed.result
    if (
      typeof result !== 'object' ||
      result === null ||
      !('totalCount' in result) ||
      typeof result.totalCount !== 'number'
    ) {
      throw new Error('terminal.list returned no totalCount')
    }
    return {
      windowLivePtys: tabs.reduce((n, tab) => n + (state.ptyIdsByTabId[tab.id]?.length ?? 0), 0),
      tabs: tabs.length,
      hostLiveTerminals: result.totalCount
    }
  }, worktreeId)
}

async function liveTerminalIn(page: Page, worktreeId: string): Promise<string> {
  await switchToWorktree(page, worktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page)
  const marker = `SLEEP_MAIN_${randomUUID().slice(0, 8)}`
  await sendToTerminal(page, ptyId, `echo ${marker}\r`)
  await waitForTerminalOutput(page, marker, 10_000, 20_000)
  return ptyId
}

async function secondWorktree(page: Page): Promise<{ first: string; second: string }> {
  await waitForSessionReady(page)
  const first = await waitForActiveWorktree(page)
  const second = (await getAllWorktreeIds(page)).find((id) => id !== first)
  if (!second) {
    throw new Error('needs the seeded secondary worktree')
  }
  return { first, second }
}

test.describe('Workspace sleep runs in main', () => {
  test('opening a workspace as soon as its sleep starts ends awake', async ({ orcaPage }) => {
    const { first, second } = await secondWorktree(orcaPage)
    await liveTerminalIn(orcaPage, second)
    await switchToWorktree(orcaPage, first)
    await orcaPage.evaluate(async (id) => {
      const store = window.__store!
      const windowPtys = (): number => {
        const state = store.getState()
        return (state.tabsByWorktree[id] ?? []).reduce(
          (n, tab) => n + (state.ptyIdsByTabId[tab.id]?.length ?? 0),
          0
        )
      }
      const reply = window.api.runtime.call({
        method: 'worktree.sleep',
        params: { worktree: `id:${id}` }
      })
      // Why wait for the window's detach: a selection made before the sleep starts is dropped by it.
      const deadline = Date.now() + 20_000
      while (windowPtys() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      store.getState().setActiveWorktree(id)
      // Why after the reply: the sleep has stopped its terminal, so a live one is the open's.
      await reply
    }, second)
    await expect
      .poll(() => readSleepState(orcaPage, second).then((state) => state.hostLiveTerminals > 0), {
        timeout: 30_000
      })
      .toBe(true)
  })
})
