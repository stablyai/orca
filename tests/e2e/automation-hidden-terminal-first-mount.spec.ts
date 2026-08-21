import { test, expect } from './helpers/mcode-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { getTerminalContent, waitForActiveTerminalManager } from './helpers/terminal'
import { BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT } from '../../src/renderer/src/constants/terminal'

async function waitForHiddenTabPtyId(
  page: Parameters<typeof waitForSessionReady>[0],
  tabId: string
): Promise<string> {
  let ptyId: string | null = null
  await expect
    .poll(
      async () => {
        ptyId = await page.evaluate((targetTabId) => {
          const state = window.__store?.getState()
          if (!state) {
            return null
          }
          return state.ptyIdsByTabId[targetTabId]?.[0] ?? null
        }, tabId)
        return ptyId
      },
      {
        timeout: 20_000,
        message: `Hidden terminal tab ${tabId} did not receive a PTY binding`
      }
    )
    .not.toBeNull()

  if (!ptyId) {
    throw new Error(`waitForHiddenTabPtyId: tab ${tabId} has no PTY id`)
  }
  return ptyId
}

async function mainSnapshotContains(
  page: Parameters<typeof waitForSessionReady>[0],
  ptyId: string,
  text: string
): Promise<boolean> {
  return page.evaluate(
    async ({ targetPtyId, expectedText }) => {
      const snapshot = await window.api.pty.getMainBufferSnapshot(targetPtyId, {
        scrollbackRows: 200
      })
      return snapshot?.data.includes(expectedText) ?? false
    },
    { targetPtyId: ptyId, expectedText: text }
  )
}

test.describe('Automation hidden terminal first mount', () => {
  test('background-mounted hidden worktree replays startup output on the first visible mount', async ({
    mcodePage
  }) => {
    await waitForSessionReady(mcodePage)
    const firstWorktreeId = await waitForActiveWorktree(mcodePage)
    await ensureTerminalVisible(mcodePage)
    await waitForActiveTerminalManager(mcodePage, 30_000)

    const secondWorktreeId = (await getAllWorktreeIds(mcodePage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'background first-mount repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    const runId = Date.now()
    const marker = `AUTO_FIRST_MOUNT_${runId}`
    const hiddenTabId = await mcodePage.evaluate(
      ({ worktreeId, marker, eventName }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Store unavailable')
        }

        window.dispatchEvent(
          new CustomEvent(eventName, {
            detail: { worktreeId }
          })
        )

        const state = store.getState()
        const tab = state.createTab(worktreeId, undefined, undefined, {
          activate: false,
          recordInteraction: false
        })
        state.queueTabStartupCommand(tab.id, {
          command: `node -e "console.log('${marker}')"`,
          telemetry: {
            launch_source: 'automation_hidden_first_mount_e2e',
            request_kind: 'new'
          }
        })
        state.setTabCustomTitle(tab.id, 'Automation hidden shell', {
          recordInteraction: false
        })
        return tab.id
      },
      {
        worktreeId: secondWorktreeId,
        marker,
        eventName: BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT
      }
    )

    const hiddenPtyId = await waitForHiddenTabPtyId(mcodePage, hiddenTabId)
    await expect
      .poll(() => mainSnapshotContains(mcodePage, hiddenPtyId, marker), {
        timeout: 20_000,
        message: 'Hidden automation terminal did not buffer startup output while off-screen'
      })
      .toBe(true)

    await switchToWorktree(mcodePage, secondWorktreeId)
    await expect
      .poll(() => getActiveWorktreeId(mcodePage), {
        timeout: 10_000,
        message: 'Hidden worktree did not become active for first-mount verification'
      })
      .toBe(secondWorktreeId)

    await mcodePage.evaluate((tabId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      state.setActiveTab(tabId)
      state.setActiveTabType('terminal')
    }, hiddenTabId)

    await ensureTerminalVisible(mcodePage)
    await waitForActiveTerminalManager(mcodePage, 30_000)

    await expect
      .poll(async () => (await getTerminalContent(mcodePage)).includes(marker), {
        timeout: 10_000,
        message: 'First visible mount did not replay the hidden automation terminal output'
      })
      .toBe(true)
  })
})
