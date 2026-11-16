/**
 * Main runs a workspace's sleep and the window follows it: Sleep from the sidebar, a phone's
 * `worktree.sleep`, sleep then an immediate wake, and a delete during a sleep.
 */
import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

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

const asleep = { windowLivePtys: 0, tabs: 1, hostLiveTerminals: 0 }

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
  test('Sleep from the sidebar stops the terminals in main and keeps the tab', async ({
    orcaPage
  }) => {
    const { first, second } = await secondWorktree(orcaPage)
    await liveTerminalIn(orcaPage, second)
    await switchToWorktree(orcaPage, first)

    const row = orcaPage.locator(`[data-worktree-sidebar] [data-worktree-id="${second}"]`).first()
    await row.click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: 'Sleep', exact: true }).click()

    await expect.poll(() => readSleepState(orcaPage, second), { timeout: 20_000 }).toEqual(asleep)
    await expect(orcaPage.getByText('Failed to sleep workspace')).toHaveCount(0)

    // Opening it again wakes it: the kept tab gets a live terminal.
    await switchToWorktree(orcaPage, second)
    await ensureTerminalVisible(orcaPage)
    await waitForActivePanePtyId(orcaPage)
    await expect
      .poll(async () => (await readSleepState(orcaPage, second)).hostLiveTerminals, {
        timeout: 20_000
      })
      .toBeGreaterThan(0)
  })

  test("a phone's sleep runs in main, and the window follows it", async ({ orcaPage }) => {
    const { first, second } = await secondWorktree(orcaPage)
    await liveTerminalIn(orcaPage, second)
    // The window shows it while the phone sleeps it: the window gives up the selection.
    const reply = await orcaPage.evaluate(
      (id) =>
        window.api.runtime.call({ method: 'worktree.sleep', params: { worktree: `id:${id}` } }),
      second
    )
    expect(reply.ok).toBe(true)
    await expect.poll(() => readSleepState(orcaPage, second), { timeout: 20_000 }).toEqual(asleep)
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId))
      .not.toBe(second)
    await switchToWorktree(orcaPage, first)
  })

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

  test('a delete during a sleep waits for it and removes the workspace', async ({ orcaPage }) => {
    const { first } = await secondWorktree(orcaPage)
    // Why its own workspace: the seeded secondary one is shared by every later spec in this run.
    const second = await orcaPage.evaluate(async (firstId) => {
      const state = window.__store!.getState()
      const repoId = state.getKnownWorktreeById(firstId)?.repoId
      if (!repoId) {
        throw new Error('no repo for the active workspace')
      }
      const created = await state.createWorktree(
        repoId,
        `e2e-sleep-delete-${Date.now()}`,
        undefined,
        'skip'
      )
      await state.fetchWorktrees(repoId)
      return created.worktree.id
    }, first)
    await liveTerminalIn(orcaPage, second)
    await switchToWorktree(orcaPage, first)
    const removed = await orcaPage.evaluate(async (id) => {
      const sleeping = window.api.runtime.call({
        method: 'worktree.sleep',
        params: { worktree: `id:${id}` }
      })
      const removing = window
        .__store!.getState()
        .removeWorktree({ id, executionHostId: null }, true)
      const [sleep, removal] = await Promise.allSettled([sleeping, removing])
      return { sleep: sleep.status, removal: removal.status }
    }, second)
    expect(removed).toEqual({ sleep: 'fulfilled', removal: 'fulfilled' })
    await expect
      .poll(async () => (await getAllWorktreeIds(orcaPage)).includes(second), { timeout: 30_000 })
      .toBe(false)
  })
})
