/**
 * Sleep Workspace shortcut: it sleeps the hovered card, a hovered multi-selection, or the active
 * workspace from its terminal, and passes the chord through when nothing awake is targeted.
 */
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getAllWorktreeIds, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { focusActiveTerminalInput } from './helpers/terminal'
import {
  giveWorkspaceALivePty,
  readWorkspaceSample,
  rowLocator
} from './helpers/slept-workspace-probe'
import { dismissSetupScriptPrompts } from './helpers/sidebar-setup-prompt'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

const ACTION_ID = 'workspace.sleep' as const
const CHORD = 'ControlOrMeta+Alt+KeyH'

async function setSleepBinding(page: Page, bindings: string[] | null): Promise<void> {
  await page.evaluate(
    async ({ actionId, bindings }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('window.__store is not available')
      }
      await (bindings
        ? state.setKeybindingOverride(actionId, bindings)
        : state.resetKeybindingOverride(actionId))
    },
    { actionId: ACTION_ID, bindings }
  )
}

/** Asleep keeps the tab and drops its terminal; awake has a live one. */
async function readAwake(
  page: Page,
  worktreeId: string
): Promise<{ awake: boolean; tabs: boolean }> {
  const sample = await readWorkspaceSample(page, worktreeId)
  return { awake: sample.livePtyCount > 0, tabs: sample.tabCount > 0 }
}

const asleep = { awake: false, tabs: true }
const awake = { awake: true, tabs: true }

async function movePointerOffSidebar(page: Page): Promise<void> {
  const viewport =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })))
  await page.mouse.move(viewport.width - 20, viewport.height / 2)
}

// Orca's key router listens on window capture; document capture runs next, before a terminal can stop the key.
async function observeShortcutClaim(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.code === 'KeyH') {
          document.body.dataset.sleepShortcutClaimed = String(event.defaultPrevented)
        }
      },
      { capture: true }
    )
  })
}

async function pressAndReadClaim(page: Page): Promise<string | undefined> {
  await page.evaluate(() => delete document.body.dataset.sleepShortcutClaimed)
  await page.keyboard.press(CHORD)
  return page.evaluate(() => document.body.dataset.sleepShortcutClaimed)
}

test.describe('Sleep Workspace shortcut', () => {
  test.beforeEach(async ({ orcaPage, electronApp }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  })

  test.afterEach(async ({ orcaPage }) => {
    await setSleepBinding(orcaPage, null)
  })

  test('sleeps the hovered card, a hovered selection, or the active workspace', async ({
    orcaPage
  }) => {
    const [first, second] = await getAllWorktreeIds(orcaPage)
    if (!first || !second) {
      throw new Error('needs the seeded secondary worktree')
    }
    await giveWorkspaceALivePty(orcaPage, second)
    await giveWorkspaceALivePty(orcaPage, first)
    await setSleepBinding(orcaPage, ['Mod+Alt+H'])
    await observeShortcutClaim(orcaPage)
    await dismissSetupScriptPrompts(orcaPage)

    // A hovered card wins over the active workspace.
    await rowLocator(orcaPage, second).hover()
    expect(await pressAndReadClaim(orcaPage)).toBe('true')
    await expect.poll(() => readAwake(orcaPage, second), { timeout: 20_000 }).toEqual(asleep)
    expect(await readAwake(orcaPage, first)).toEqual(awake)

    // A hovered card with nothing awake passes the chord through instead of sleeping the active one.
    expect(await pressAndReadClaim(orcaPage)).toBe('false')
    expect(await readAwake(orcaPage, first)).toEqual(awake)

    // A selection that holds the hovered card sleeps as one.
    await giveWorkspaceALivePty(orcaPage, second)
    await expect.poll(() => readAwake(orcaPage, second), { timeout: 20_000 }).toEqual(awake)
    await rowLocator(orcaPage, first).click()
    await rowLocator(orcaPage, second).click({ modifiers: ['Shift'] })
    await rowLocator(orcaPage, second).hover()
    expect(await pressAndReadClaim(orcaPage)).toBe('true')
    await expect.poll(() => readAwake(orcaPage, first), { timeout: 20_000 }).toEqual(asleep)
    await expect.poll(() => readAwake(orcaPage, second), { timeout: 20_000 }).toEqual(asleep)

    // No hovered card: the active workspace sleeps, even with focus in its terminal.
    await giveWorkspaceALivePty(orcaPage, first)
    await expect.poll(() => readAwake(orcaPage, first), { timeout: 20_000 }).toEqual(awake)
    await movePointerOffSidebar(orcaPage)
    await focusActiveTerminalInput(orcaPage)
    expect(await pressAndReadClaim(orcaPage)).toBe('true')
    await expect.poll(() => readAwake(orcaPage, first), { timeout: 20_000 }).toEqual(asleep)
  })
})
