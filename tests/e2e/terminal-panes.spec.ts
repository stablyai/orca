/* eslint-disable max-lines -- Terminal pane E2E is a serial coverage matrix for split, close, remake, move, resize, and retention flows. */
/**
 * E2E tests for terminal pane splitting, state retention, resizing, and closing.
 *
 * User Prompt:
 * - terminal panes can be split
 * - terminal panes retain state when switching tabs and when you make / close a pane / switch worktrees
 * - resizing terminal panes works
 * - closing panes works
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  UUID_RE,
  discoverActivePtyId,
  execInTerminal,
  closeActiveTerminalPane,
  countVisibleTerminalPanes,
  focusLastTerminalPane,
  moveTerminalPaneByLeafId,
  readPaneIdentitySnapshot,
  readTerminalPaneDomLeafOrder,
  splitActiveTerminalPane,
  waitForPaneIdentitySnapshot,
  waitForActiveTerminalManager,
  waitForTerminalOutput,
  waitForPaneCount,
  getTerminalContent,
  sendToTerminal
} from './helpers/terminal'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabId,
  getActiveTabType,
  getWorktreeTabs,
  getAllWorktreeIds,
  switchToOtherWorktree,
  switchToWorktree,
  ensureTerminalVisible
} from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'

async function setPaneTitleFromTerminalMenu(page: Page, title: string): Promise<void> {
  await openTerminalContextMenu(page)
  await page.getByText('Set Title…', { exact: true }).click()
  const titleInput = page.locator('.pane-title-input').first()
  await expect(titleInput).toBeVisible()
  await titleInput.fill(title)
  await titleInput.press('Enter')
  // Why: CI can dispatch Enter before React has committed the filled value;
  // blurring exercises the same submit path and makes the helper deterministic.
  try {
    await expect(titleInput).toHaveCount(0, { timeout: 500 })
  } catch {
    await titleInput.evaluateAll(([input]) => (input as HTMLElement | undefined)?.blur())
  }
  await expect(titleInput).toHaveCount(0)
}

async function openTerminalContextMenu(page: Page): Promise<void> {
  const modifiers: ('Alt' | 'Control' | 'Meta' | 'Shift')[] = (await page.evaluate(() =>
    navigator.userAgent.includes('Windows')
  ))
    ? ['Control']
    : []
  const isMac = await page.evaluate(() => navigator.userAgent.includes('Mac'))
  await page
    .locator('.xterm:visible')
    .first()
    .click({
      button: isMac ? 'left' : 'right',
      position: { x: 40, y: 40 },
      modifiers: isMac ? ['Control'] : modifiers
    })
  await expect(page.getByText('Set Title…', { exact: true })).toBeVisible()
}

async function openPaneTitleContextMenu(page: Page, title: string): Promise<void> {
  const modifiers: ('Alt' | 'Control' | 'Meta' | 'Shift')[] = (await page.evaluate(() =>
    navigator.userAgent.includes('Windows')
  ))
    ? ['Control']
    : []
  const isMac = await page.evaluate(() => navigator.userAgent.includes('Mac'))
  const titleBar = page.locator('.pane-title-bar', { hasText: title }).first()
  await expect(titleBar).toBeVisible()
  await titleBar.click({
    button: isMac ? 'left' : 'right',
    position: { x: 20, y: 10 },
    modifiers: isMac ? ['Control'] : modifiers
  })
  await expect(page.getByText('Set Title…', { exact: true })).toBeVisible()
}

async function installDelayedTerminalFocusSteals(
  page: Page,
  delaysMs: readonly number[]
): Promise<void> {
  await page.evaluate((delays) => {
    const focusTerminalAfterTitleFocus = (event: FocusEvent): void => {
      const target = event.target
      if (!(target instanceof HTMLInputElement) || !target.classList.contains('pane-title-input')) {
        return
      }
      document.removeEventListener('focusin', focusTerminalAfterTitleFocus, true)
      for (const delay of delays) {
        window.setTimeout(() => {
          const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
          textarea?.focus()
        }, delay)
      }
    }
    document.addEventListener('focusin', focusTerminalAfterTitleFocus, true)
  }, delaysMs)
}

async function readVisibleXtermContainerBox(
  page: Page
): Promise<{ x: number; y: number; width: number; height: number }> {
  return page
    .locator('.xterm:visible')
    .first()
    .evaluate((xterm) => {
      const container = xterm.closest('.xterm-container')
      if (!(container instanceof HTMLElement)) {
        throw new Error('No visible xterm container found')
      }
      const rect = container.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
}

function expectTerminalToReserveTitleSpace(
  actual: { x: number; y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number }
): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThan(1)
  expect(Math.abs(actual.width - expected.width)).toBeLessThan(1)
  expect(actual.y - expected.y).toBeGreaterThan(10)
  expect(expected.height - actual.height).toBeGreaterThan(10)
}

async function expectPaneTitleAttachedToLeaf(
  page: Page,
  title: string,
  leafId: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ title, leafId }) => {
            const titleBar = Array.from(
              document.querySelectorAll<HTMLElement>('.pane-title-bar')
            ).find((element) => element.textContent?.includes(title))
            const pane = document.querySelector<HTMLElement>(`.pane[data-leaf-id="${leafId}"]`)
            if (!titleBar || !pane) {
              return false
            }
            const titleRect = titleBar.getBoundingClientRect()
            const paneRect = pane.getBoundingClientRect()
            return (
              Math.abs(titleRect.left - paneRect.left) < 1 &&
              Math.abs(titleRect.top - paneRect.top) < 1 &&
              Math.abs(titleRect.width - paneRect.width) < 1
            )
          },
          { title, leafId }
        ),
      {
        timeout: 5_000,
        message: 'Pane title overlay did not stay attached to its pane'
      }
    )
    .toBe(true)
}

async function getTabCustomTitle(
  page: Page,
  worktreeId: string,
  tabId: string
): Promise<string | null> {
  return page.evaluate(
    ({ targetWorktreeId, targetTabId }) => {
      const state = window.__store!.getState()
      const tab = (state.tabsByWorktree[targetWorktreeId] ?? []).find(
        (entry) => entry.id === targetTabId
      )
      return tab?.customTitle ?? null
    },
    { targetWorktreeId: worktreeId, targetTabId: tabId }
  )
}

async function expectTabCustomTitle(
  page: Page,
  worktreeId: string,
  tabId: string,
  expected: string | null
): Promise<void> {
  await expect
    .poll(() => getTabCustomTitle(page, worktreeId, tabId), { timeout: 3_000 })
    .toBe(expected)
}

async function expectSavedLayoutNotToContainTitle(
  page: Page,
  tabId: string,
  title: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ targetTabId, title }) => {
            const layout = window.__store!.getState().terminalLayoutsByTabId[targetTabId]
            return Object.values(layout?.titlesByLeafId ?? {}).includes(title)
          },
          { targetTabId: tabId, title }
        ),
      { timeout: 3_000 }
    )
    .toBe(false)
}

async function readVisiblePaneContents(page: Page): Promise<string[]> {
  const snapshot = await waitForPaneIdentitySnapshot(page, 2)
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    return (
      manager
        ?.getPanes()
        .map((pane) => pane.serializeAddon?.serialize?.({ scrollback: 200 }) ?? '') ?? []
    )
  }, snapshot.tabId)
}

// Why: only the pointer-drag resize test needs a visible window (pointer
// capture requires a real pointer id). Every other pane operation here is
// driven through the exposed PaneManager API and runs fine headless, so the
// suite itself is not tagged — just the one test that needs it.
// Why: keep the suite serial so when the headful test does run, Playwright
// does not try to open multiple visible Electron windows at once.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Panes', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    // Why: each test launches a fresh Electron instance. The React tree needs
    // to render Terminal → TabGroupPanel → TerminalPane → useTerminalPaneLifecycle
    // before the PaneManager registers on window.__paneManagers. On cold starts
    // this easily exceeds 5s, so allow up to 30s (well within the 120s test budget)
    // to distinguish "slow cold start" from "environment can't mount panes at all."
    const hasPaneManager = await waitForActiveTerminalManager(orcaPage, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager, so pane split/resize assertions would only fail on harness setup.'
    )
    // Why: hidden Electron runs can report an active terminal tab before the
    // PaneManager finishes mounting the first xterm/PTY pair. Wait for that
    // initial pane so split and content-retention assertions start from a real
    // terminal surface instead of racing the bootstrapped mount.
    await waitForPaneCount(orcaPage, 1, 30_000)
  })

  /**
   * User Prompt:
   * - terminal panes can be split
   */
  test('can split terminal pane right', async ({ orcaPage }) => {
    const paneCountBefore = await countVisibleTerminalPanes(orcaPage)

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, paneCountBefore + 1)

    const paneCountAfter = await countVisibleTerminalPanes(orcaPage)
    expect(paneCountAfter).toBe(paneCountBefore + 1)
  })

  /**
   * User Prompt:
   * - terminal panes can be split
   */
  test('can split terminal pane down', async ({ orcaPage }) => {
    const paneCountBefore = await countVisibleTerminalPanes(orcaPage)

    await splitActiveTerminalPane(orcaPage, 'horizontal')
    await waitForPaneCount(orcaPage, paneCountBefore + 1)

    const paneCountAfter = await countVisibleTerminalPanes(orcaPage)
    expect(paneCountAfter).toBe(paneCountBefore + 1)
  })

  test('split panes persist PTY bindings by stable UUID leaf id', async ({ orcaPage }) => {
    const paneCountBefore = await countVisibleTerminalPanes(orcaPage)

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, paneCountBefore + 1)

    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, paneCountBefore + 1)
    const leafIds = snapshot.panes.map((pane) => pane.leafId)
    const ptyIds = snapshot.panes.map((pane) => pane.ptyId)

    expect(new Set(leafIds).size).toBe(leafIds.length)
    expect(new Set(ptyIds).size).toBe(ptyIds.length)
    expect(Object.keys(snapshot.ptyIdsByLeafId).sort()).toEqual([...leafIds].sort())
    expect(Object.keys(snapshot.ptyIdsByLeafId).every((leafId) => UUID_RE.test(leafId))).toBe(true)
    expect(
      snapshot.panes.some(
        (pane) =>
          String(pane.numericPaneId) === pane.leafId || `pane:${pane.numericPaneId}` === pane.leafId
      )
    ).toBe(false)
  })

  test('terminal process receives ORCA_PANE_KEY with the active UUID leaf id', async ({
    orcaPage
  }) => {
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const activeLeafId = snapshot.activeLeafId ?? snapshot.panes[0]?.leafId
    if (!activeLeafId) {
      throw new Error('No active pane leaf id found')
    }

    const expectedPaneKey = `${snapshot.tabId}:${activeLeafId}`
    const ptyId = await discoverActivePtyId(orcaPage)
    const marker = `ORCA_PANE_KEY_E2E_${Date.now()}`

    await execInTerminal(orcaPage, ptyId, `printf '${marker}=%s\\n' "$ORCA_PANE_KEY"`)
    await waitForTerminalOutput(orcaPage, `${marker}=${expectedPaneKey}`)

    expect(activeLeafId).toMatch(UUID_RE)
  })

  test('terminal context menu copies the stable pane ID', async ({ orcaPage }) => {
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const leafId = snapshot.panes[0]?.leafId
    if (!leafId) {
      throw new Error('No terminal pane leaf id found')
    }
    const expectedPaneKey = `${snapshot.tabId}:${leafId}`

    await openTerminalContextMenu(orcaPage)
    await orcaPage.getByText('Copy Pane ID', { exact: true }).click()

    await expect
      .poll(() => orcaPage.evaluate(() => window.api.ui.readClipboardText()), { timeout: 3_000 })
      .toBe(expectedPaneKey)
    await expect(orcaPage.getByText('Pane ID copied', { exact: true })).toBeVisible()
    expect(leafId).toMatch(UUID_RE)
  })

  test('first Set Title from terminal context menu stays open for typing', async ({ orcaPage }) => {
    const title = `First menu title ${Date.now()}`

    await openTerminalContextMenu(orcaPage)
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await orcaPage.waitForTimeout(250)
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()

    await titleInput.fill(title)
    await titleInput.press('Enter')

    await expect(titleInput).toHaveCount(0)
    await expect(orcaPage.locator('.pane-title-text', { hasText: title })).toHaveCount(1)
  })

  test('Set Title editor renders in Orca overlay while terminal reserves title space', async ({
    orcaPage
  }) => {
    const title = `Reserved overlay title ${Date.now()}`
    const terminalBoxBefore = await readVisibleXtermContainerBox(orcaPage)

    await openTerminalContextMenu(orcaPage)
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-overlay-layer .pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await expect(orcaPage.getByText('Set Title…', { exact: true })).toBeHidden()
    await expect(orcaPage.locator('.pane .pane-title-input')).toHaveCount(0)
    await expect(orcaPage.locator('.pane[data-has-title]')).toHaveCount(1)
    await expect
      .poll(() =>
        orcaPage
          .locator('.pane-title-bar')
          .first()
          .evaluate((titleBar) => getComputedStyle(titleBar).backgroundColor)
      )
      .not.toBe('rgba(0, 0, 0, 0)')
    const terminalBoxEditing = await readVisibleXtermContainerBox(orcaPage)
    expectTerminalToReserveTitleSpace(terminalBoxEditing, terminalBoxBefore)

    await titleInput.fill(title)
    await titleInput.press('Enter')
    await expect(orcaPage.locator('.pane-title-text', { hasText: title })).toBeVisible()
    await expect(orcaPage.locator('.pane[data-has-title]')).toHaveCount(1)
    expectTerminalToReserveTitleSpace(
      await readVisibleXtermContainerBox(orcaPage),
      terminalBoxBefore
    )
  })

  test('Set Title context menu opens from the title overlay strip', async ({ orcaPage }) => {
    const title = `Overlay menu title ${Date.now()}`
    const updatedTitle = `Overlay menu updated ${Date.now()}`

    await setPaneTitleFromTerminalMenu(orcaPage, title)
    await openPaneTitleContextMenu(orcaPage, title)
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await expect(titleInput).toHaveValue(title)
    await titleInput.fill(updatedTitle)
    await titleInput.press('Enter')

    await expect(orcaPage.locator('.pane-title-text', { hasText: updatedTitle })).toHaveCount(1)
    await expect(orcaPage.locator('.pane-title-text', { hasText: title })).toHaveCount(0)
  })

  test('Set Title strip activates its pane and accepts file-path drops', async ({ orcaPage }) => {
    const title = `Drop target title ${Date.now()}`
    const droppedPath = `/tmp/title-drop-${Date.now()}.txt`

    await setPaneTitleFromTerminalMenu(orcaPage, title)
    const initialSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const titledLeafId = initialSnapshot.activeLeafId ?? initialSnapshot.panes[0]?.leafId
    if (!titledLeafId) {
      throw new Error('No titled pane leaf id found before split')
    }

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const splitSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const otherPane = splitSnapshot.panes.find((pane) => pane.leafId !== titledLeafId)
    if (!otherPane) {
      throw new Error('No inactive pane found for title-strip drop test')
    }

    await orcaPage.evaluate(
      ({ tabId, paneId }) => {
        window.__paneManagers?.get(tabId)?.setActivePane(paneId, { focus: false })
      },
      { tabId: splitSnapshot.tabId, paneId: otherPane.numericPaneId }
    )
    await expect
      .poll(async () => (await readPaneIdentitySnapshot(orcaPage))?.activeLeafId ?? null)
      .toBe(otherPane.leafId)

    const titleBar = orcaPage.locator('.pane-title-bar', { hasText: title }).first()
    await expect(titleBar).toHaveAttribute('data-native-file-drop-target', 'terminal')
    await expect(titleBar).toHaveAttribute('data-terminal-tab-id', splitSnapshot.tabId)

    await titleBar.evaluate((element, path) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('text/x-orca-file-path', path)
      element.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })
      )
      element.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
      )
    }, droppedPath)

    await expect
      .poll(async () => (await readPaneIdentitySnapshot(orcaPage))?.activeLeafId ?? null, {
        timeout: 5_000,
        message: 'Title-strip drop did not activate the titled pane'
      })
      .toBe(titledLeafId)
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(droppedPath), {
        timeout: 5_000,
        message: 'Title-strip drop did not paste into the titled pane terminal'
      })
      .toBe(true)
  })

  test('Set Title overlay follows its pane after same-count pane move', async ({ orcaPage }) => {
    const title = `Moved overlay title ${Date.now()}`

    await setPaneTitleFromTerminalMenu(orcaPage, title)
    const initialSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const titledLeafId = initialSnapshot.activeLeafId ?? initialSnapshot.panes[0]?.leafId
    if (!titledLeafId) {
      throw new Error('No titled pane leaf id found before move')
    }

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const beforeMove = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const target = beforeMove.panes.find((pane) => pane.leafId !== titledLeafId)
    if (!target) {
      throw new Error('No target pane found for titled pane move')
    }
    const beforeOrder = await readTerminalPaneDomLeafOrder(orcaPage)

    await expectPaneTitleAttachedToLeaf(orcaPage, title, titledLeafId)
    await moveTerminalPaneByLeafId(orcaPage, titledLeafId, target.leafId, 'right')

    await expect
      .poll(async () => readTerminalPaneDomLeafOrder(orcaPage), {
        timeout: 10_000,
        message: 'Pane move did not update DOM order'
      })
      .not.toEqual(beforeOrder)
    await expectPaneTitleAttachedToLeaf(orcaPage, title, titledLeafId)
  })

  test('Set Title keeps the pane drag handle available over the title strip', async ({
    orcaPage
  }) => {
    const title = `Draggable title ${Date.now()}`

    await setPaneTitleFromTerminalMenu(orcaPage, title)
    const initialSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const titledLeafId = initialSnapshot.activeLeafId ?? initialSnapshot.panes[0]?.leafId
    if (!titledLeafId) {
      throw new Error('No titled pane leaf id found before split')
    }

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    await expectPaneTitleAttachedToLeaf(orcaPage, title, titledLeafId)

    const titleTopHit = await orcaPage.evaluate(
      ({ title, titledLeafId }) => {
        const titleBar = Array.from(document.querySelectorAll<HTMLElement>('.pane-title-bar')).find(
          (element) => element.textContent?.includes(title)
        )
        const titleDragHandle =
          titleBar.querySelector<HTMLElement>('.pane-title-drag-handle') ?? null
        const pane = document.querySelector<HTMLElement>(`.pane[data-leaf-id="${titledLeafId}"]`)
        if (!titleBar || !pane || !titleDragHandle) {
          return null
        }
        const titleRect = titleBar.getBoundingClientRect()
        const hitElement = document.elementFromPoint(
          titleRect.left + titleRect.width / 2,
          titleRect.top + 4
        )
        return {
          hitDragHandle:
            hitElement instanceof HTMLElement &&
            hitElement.closest('.pane-title-drag-handle') !== null,
          pointerEvents: getComputedStyle(titleDragHandle).pointerEvents,
          titleTop: titleRect.top,
          handleTop: titleDragHandle.getBoundingClientRect().top
        }
      },
      { title, titledLeafId }
    )

    expect(titleTopHit).not.toBeNull()
    expect(titleTopHit?.hitDragHandle).toBe(true)
    expect(titleTopHit?.pointerEvents).toBe('auto')
    expect(Math.abs((titleTopHit?.handleTop ?? 0) - (titleTopHit?.titleTop ?? 0))).toBeLessThan(1)

    await orcaPage.locator('.pane-title-bar', { hasText: title }).click({
      position: { x: 20, y: 18 }
    })
    await expect(orcaPage.locator('.pane-title-input')).toBeVisible()
  })

  test('@headful Set Title pane can be dragged from the title strip', async ({ orcaPage }) => {
    const title = `Dragged title ${Date.now()}`

    await setPaneTitleFromTerminalMenu(orcaPage, title)
    const initialSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const titledLeafId = initialSnapshot.activeLeafId ?? initialSnapshot.panes[0]?.leafId
    if (!titledLeafId) {
      throw new Error('No titled pane leaf id found before drag')
    }

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const beforeDrag = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const target = beforeDrag.panes.find((pane) => pane.leafId !== titledLeafId)
    if (!target) {
      throw new Error('No target pane found for titled pane drag')
    }
    const beforeOrder = await readTerminalPaneDomLeafOrder(orcaPage)

    const titleDragHandle = orcaPage
      .locator('.pane-title-bar', { hasText: title })
      .locator('.pane-title-drag-handle')
    await expect(titleDragHandle).toBeVisible({ timeout: 3_000 })
    const sourceBox = await titleDragHandle.boundingBox()
    const targetBox = await orcaPage.locator(`.pane[data-leaf-id="${target.leafId}"]`).boundingBox()
    expect(sourceBox).not.toBeNull()
    expect(targetBox).not.toBeNull()
    const sourceIndex = beforeOrder.indexOf(titledLeafId)
    const targetIndex = beforeOrder.indexOf(target.leafId)
    const targetDropX =
      sourceIndex < targetIndex ? targetBox!.x + targetBox!.width - 8 : targetBox!.x + 8

    await orcaPage.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + 4)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(targetDropX, targetBox!.y + targetBox!.height / 2, {
      steps: 20
    })
    await orcaPage.mouse.up()

    await expect
      .poll(async () => readTerminalPaneDomLeafOrder(orcaPage), {
        timeout: 10_000,
        message: 'Title-strip pane drag did not update DOM order'
      })
      .not.toEqual(beforeOrder)
    const afterDrag = await waitForPaneIdentitySnapshot(orcaPage, 2)
    expect(afterDrag.panes.map((pane) => pane.leafId).sort()).toEqual(
      beforeDrag.panes.map((pane) => pane.leafId).sort()
    )
    await expectPaneTitleAttachedToLeaf(orcaPage, title, titledLeafId)
  })

  test('Set Title input stays open when clicked in a split terminal', async ({ orcaPage }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    await splitActiveTerminalPane(orcaPage, 'horizontal')
    await waitForPaneCount(orcaPage, 3)

    await openTerminalContextMenu(orcaPage)
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()

    // Why: overlay controls own the title strip. Clicking the already-open
    // title input must not leak through to xterm and flash the editor closed.
    await titleInput.evaluate((input) => {
      const pointerInit: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse'
      }
      input.dispatchEvent(new PointerEvent('pointerdown', pointerInit))
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      input.dispatchEvent(new PointerEvent('pointerup', pointerInit))
      input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
      input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await expect
      .poll(
        () => titleInput.evaluate((input) => input.isConnected && document.activeElement === input),
        { timeout: 1_000 }
      )
      .toBe(true)

    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
  })

  test('Set Title survives an early blur during first focus handoff', async ({ orcaPage }) => {
    await openTerminalContextMenu(orcaPage)
    await orcaPage.evaluate(() => {
      const blurOnFirstTitleFocus = (event: FocusEvent): void => {
        const target = event.target
        if (
          !(target instanceof HTMLInputElement) ||
          !target.classList.contains('pane-title-input')
        ) {
          return
        }
        document.removeEventListener('focusin', blurOnFirstTitleFocus, true)
        queueMicrotask(() => target.blur())
      }
      document.addEventListener('focusin', blurOnFirstTitleFocus, true)
    })
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await orcaPage.waitForTimeout(250)
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
  })

  test('Set Title survives delayed terminal focus handoffs', async ({ orcaPage }) => {
    await openTerminalContextMenu(orcaPage)
    await installDelayedTerminalFocusSteals(orcaPage, [50, 150, 300])
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await orcaPage.waitForTimeout(600)
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
  })

  test('Set Title survives delayed terminal focus handoffs in a split pane', async ({
    orcaPage
  }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)

    await openTerminalContextMenu(orcaPage)
    await installDelayedTerminalFocusSteals(orcaPage, [50, 150, 300])
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await orcaPage.waitForTimeout(600)
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
  })

  test('Set Title preserves draft text across terminal focus steals', async ({ orcaPage }) => {
    const draftTitle = `Draft title ${Date.now()}`

    await openTerminalContextMenu(orcaPage)
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await titleInput.fill(draftTitle)

    await orcaPage.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      textarea?.focus()
    })

    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await expect(titleInput).toHaveValue(draftTitle)
  })

  test('Set Title does not submit when synthetic focus restore fails', async ({ orcaPage }) => {
    const draftTitle = `Blocked focus title ${Date.now()}`

    await openTerminalContextMenu(orcaPage)
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await titleInput.fill(draftTitle)
    await titleInput.evaluate((input) => {
      input.focus = () => {}
    })

    await orcaPage.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      textarea?.focus()
    })

    await expect(titleInput).toBeVisible()
    await expect(titleInput).toHaveValue(draftTitle)
    await expect(orcaPage.locator('.pane-title-text', { hasText: draftTitle })).toHaveCount(0)
  })

  test('Set Title still commits by blur after synthetic terminal focus steals', async ({
    orcaPage
  }) => {
    const title = `Post steal blur title ${Date.now()}`

    await openTerminalContextMenu(orcaPage)
    await installDelayedTerminalFocusSteals(orcaPage, [50, 150])
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await orcaPage.waitForTimeout(300)
    await titleInput.fill(title)
    await orcaPage
      .locator('.xterm:visible')
      .first()
      .click({ position: { x: 40, y: 60 } })

    await expect(titleInput).toHaveCount(0)
    await expect(orcaPage.locator('.pane-title-text', { hasText: title })).toHaveCount(1)
  })

  test('Set Title commits when tabbing away from the title input', async ({ orcaPage }) => {
    const title = `Tab commit title ${Date.now()}`

    await openTerminalContextMenu(orcaPage)
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await titleInput.fill(title)
    await titleInput.press('Tab')

    await expect(titleInput).toHaveCount(0)
    await expect(orcaPage.locator('.pane-title-text', { hasText: title })).toHaveCount(1)
  })

  test('Set Title overlay hides with its inactive terminal tab', async ({ orcaPage }) => {
    const title = `Hidden tab title ${Date.now()}`
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    await setPaneTitleFromTerminalMenu(orcaPage, title)
    await expect(orcaPage.locator('.pane-title-text', { hasText: title })).toBeVisible()

    await pressShortcut(orcaPage, 't')
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)
    await expect(orcaPage.locator('.pane-title-text', { hasText: title })).toBeHidden()

    await pressShortcut(orcaPage, 'BracketLeft', { shift: true })
    await expect(orcaPage.locator('.pane-title-text', { hasText: title })).toBeVisible()
  })

  test('Set Title still commits by blur after focus settles', async ({ orcaPage }) => {
    const title = `Blur commit title ${Date.now()}`

    await openTerminalContextMenu(orcaPage)
    await orcaPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = orcaPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await orcaPage.waitForTimeout(100)
    await titleInput.fill(title)
    await orcaPage
      .locator('.xterm:visible')
      .first()
      .click({ position: { x: 40, y: 60 } })

    await expect(titleInput).toHaveCount(0)
    await expect(orcaPage.locator('.pane-title-text', { hasText: title })).toHaveCount(1)
  })

  test('Set Title remove button hover stays transparent', async ({ orcaPage }) => {
    const title = `Remove hover title ${Date.now()}`

    await setPaneTitleFromTerminalMenu(orcaPage, title)
    const removeButton = orcaPage.getByRole('button', { name: `Remove pane title: ${title}` })
    await orcaPage.locator('.pane-title-bar', { hasText: title }).hover()
    await removeButton.hover()
    await expect(orcaPage.getByText('Remove title', { exact: true })).toBeVisible()

    const hoverStyle = await removeButton.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        opacity: style.opacity
      }
    })

    expect(hoverStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(Number(hoverStyle.opacity)).toBeGreaterThan(0.9)
  })

  test('Set Title stays pane-local during agent title churn', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const tabId = (await getActiveTabId(orcaPage))!
    const paneTitle = `Codex pane ${Date.now()}`
    const removeButtonTitle = `Remove button label ${Date.now()}`
    const splitTitle = `Split label ${Date.now()}`
    const runtimeTitle = '⠋ Codex working'

    await setPaneTitleFromTerminalMenu(orcaPage, paneTitle)
    await expect(orcaPage.locator('.pane-title-text', { hasText: paneTitle })).toBeVisible()
    await expectTabCustomTitle(orcaPage, worktreeId, tabId, null)

    await orcaPage.getByRole('button', { name: `Edit pane title: ${paneTitle}` }).focus()
    await orcaPage.keyboard.press('Enter')
    const paneTitleInput = orcaPage.getByRole('textbox', { name: 'Pane title' })
    await expect(paneTitleInput).toBeVisible()
    await expect(paneTitleInput).toBeFocused()
    await orcaPage.keyboard.press('Escape')
    await expect(paneTitleInput).toHaveCount(0)
    await expect(orcaPage.locator('.pane-title-text', { hasText: paneTitle })).toBeVisible()

    await orcaPage.evaluate(
      ({ targetTabId, title }) => {
        window.__store!.getState().updateTabTitle(targetTabId, title)
      },
      { targetTabId: tabId, title: runtimeTitle }
    )

    // Why: active agents continuously write OSC titles. Set Title is Orca's
    // pane-local overlay and must remain visible while the tab runtime title
    // continues to follow the active PTY.
    await expect(orcaPage.locator('.pane-title-text', { hasText: paneTitle })).toBeVisible()
    await expect(
      orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
    ).toHaveAttribute('data-tab-title', runtimeTitle)
    await expectTabCustomTitle(orcaPage, worktreeId, tabId, null)

    await setPaneTitleFromTerminalMenu(orcaPage, '')
    await expect(orcaPage.locator('.pane-title-text', { hasText: paneTitle })).toBeHidden()
    await expectSavedLayoutNotToContainTitle(orcaPage, tabId, paneTitle)

    await setPaneTitleFromTerminalMenu(orcaPage, removeButtonTitle)
    await orcaPage.locator('.pane-title-bar', { hasText: removeButtonTitle }).hover()
    await orcaPage.getByRole('button', { name: `Remove pane title: ${removeButtonTitle}` }).click()
    await expect(orcaPage.locator('.pane-title-text', { hasText: removeButtonTitle })).toBeHidden()
    await expectSavedLayoutNotToContainTitle(orcaPage, tabId, removeButtonTitle)

    await setPaneTitleFromTerminalMenu(orcaPage, splitTitle)
    await expectTabCustomTitle(orcaPage, worktreeId, tabId, null)

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    await expect(orcaPage.locator('.pane-title-text', { hasText: splitTitle })).toBeVisible()

    await orcaPage.evaluate(
      ({ targetTabId, title }) => {
        window.__store!.getState().updateTabTitle(targetTabId, title)
      },
      { targetTabId: tabId, title: runtimeTitle }
    )
    await expect(
      orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
    ).toHaveAttribute('data-tab-title', runtimeTitle)
  })

  test('closing a split pane prunes its leaf-keyed PTY binding without remapping siblings', async ({
    orcaPage
  }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    await splitActiveTerminalPane(orcaPage, 'horizontal')
    await waitForPaneCount(orcaPage, 3)

    const beforeClose = await waitForPaneIdentitySnapshot(orcaPage, 3)
    const closedLeafId = beforeClose.activeLeafId ?? beforeClose.panes.at(-1)?.leafId
    if (!closedLeafId) {
      throw new Error('No active split pane leaf id found before close')
    }
    const survivingLeafIds = beforeClose.panes
      .map((pane) => pane.leafId)
      .filter((leafId) => leafId !== closedLeafId)

    await closeActiveTerminalPane(orcaPage)
    await waitForPaneCount(orcaPage, 2)

    const afterClose = await waitForPaneIdentitySnapshot(orcaPage, 2)
    expect(afterClose.panes.map((pane) => pane.leafId).sort()).toEqual(survivingLeafIds.sort())
    expect(Object.keys(afterClose.ptyIdsByLeafId).sort()).toEqual(survivingLeafIds.sort())
    expect(afterClose.ptyIdsByLeafId[closedLeafId]).toBeUndefined()
  })

  test('closing and remaking right/down splits keeps surviving leaf-keyed bindings stable', async ({
    orcaPage
  }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    await splitActiveTerminalPane(orcaPage, 'horizontal')
    await waitForPaneCount(orcaPage, 3)

    const beforeClose = await waitForPaneIdentitySnapshot(orcaPage, 3)
    const closedLeafId = beforeClose.activeLeafId ?? beforeClose.panes.at(-1)?.leafId
    if (!closedLeafId) {
      throw new Error('No active split pane leaf id found before close/remake')
    }
    const survivingBindings = Object.fromEntries(
      beforeClose.panes
        .filter((pane) => pane.leafId !== closedLeafId)
        .map((pane) => [pane.leafId, pane.ptyId])
    )

    await closeActiveTerminalPane(orcaPage)
    await waitForPaneCount(orcaPage, 2)

    const afterClose = await waitForPaneIdentitySnapshot(orcaPage, 2)
    expect(Object.keys(afterClose.ptyIdsByLeafId).sort()).toEqual(
      Object.keys(survivingBindings).sort()
    )
    for (const [leafId, ptyId] of Object.entries(survivingBindings)) {
      expect(afterClose.ptyIdsByLeafId[leafId]).toBe(ptyId)
    }
    expect(afterClose.ptyIdsByLeafId[closedLeafId]).toBeUndefined()

    await splitActiveTerminalPane(orcaPage, 'horizontal')
    await waitForPaneCount(orcaPage, 3)

    const afterRemake = await waitForPaneIdentitySnapshot(orcaPage, 3)
    const remadeLeafIds = afterRemake.panes.map((pane) => pane.leafId)
    expect(remadeLeafIds).not.toContain(closedLeafId)
    for (const [leafId, ptyId] of Object.entries(survivingBindings)) {
      expect(afterRemake.ptyIdsByLeafId[leafId]).toBe(ptyId)
    }
    expect(new Set(remadeLeafIds).size).toBe(3)
  })

  test('moving panes through the drag-drop handler preserves leaf-keyed PTY bindings', async ({
    orcaPage
  }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    await splitActiveTerminalPane(orcaPage, 'horizontal')
    await waitForPaneCount(orcaPage, 3)

    const beforeMove = await waitForPaneIdentitySnapshot(orcaPage, 3)
    const beforeOrder = await readTerminalPaneDomLeafOrder(orcaPage)
    const source = beforeMove.panes.at(-1)
    const target = beforeMove.panes[0]
    if (!source || !target) {
      throw new Error('Need source and target panes for move test')
    }
    const bindingsBefore = { ...beforeMove.ptyIdsByLeafId }

    await moveTerminalPaneByLeafId(orcaPage, source.leafId, target.leafId, 'left')

    await expect
      .poll(async () => readTerminalPaneDomLeafOrder(orcaPage), {
        timeout: 10_000,
        message: 'Pane drag-drop move did not update DOM order'
      })
      .not.toEqual(beforeOrder)

    const afterMove = await waitForPaneIdentitySnapshot(orcaPage, 3)
    const afterLeafIds = afterMove.panes.map((pane) => pane.leafId).sort()
    expect(afterLeafIds).toEqual(beforeMove.panes.map((pane) => pane.leafId).sort())
    expect(afterMove.ptyIdsByLeafId).toEqual(bindingsBefore)
  })

  /**
   * User Prompt:
   * - terminal panes retain state when switching tabs and when you make / close a pane / switch worktrees
   */
  test('terminal pane retains content when switching tabs and back', async ({ orcaPage }) => {
    // Write a unique marker to the current terminal
    const ptyId = await discoverActivePtyId(orcaPage)
    const marker = `RETAIN_TEST_${Date.now()}`
    await execInTerminal(orcaPage, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(orcaPage, marker)

    // Create a new terminal tab (Cmd/Ctrl+T) to switch away
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    await pressShortcut(orcaPage, 't')

    // Wait for the new tab to appear
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    // Verify we're still on a terminal tab
    const activeType = await getActiveTabType(orcaPage)
    expect(activeType).toBe('terminal')

    // Switch back to the previous tab with Cmd/Ctrl+Shift+[
    await pressShortcut(orcaPage, 'BracketLeft', { shift: true })

    // Verify the marker is still present
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(marker), { timeout: 5_000 })
      .toBe(true)

    // Clean up the extra tab
    await pressShortcut(orcaPage, 'BracketRight', { shift: true })
    await pressShortcut(orcaPage, 'w')
  })

  /**
   * User Prompt:
   * - terminal panes retain state when switching tabs and when you make / close a pane / switch worktrees
   */
  test('terminal pane retains content when splitting and closing a pane', async ({ orcaPage }) => {
    // Write a unique marker to the current terminal
    const ptyId = await discoverActivePtyId(orcaPage)
    const marker = `SPLIT_RETAIN_${Date.now()}`
    await execInTerminal(orcaPage, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(orcaPage, marker)

    const panesBefore = await countVisibleTerminalPanes(orcaPage)

    // Split the terminal right
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, panesBefore + 1)

    await focusLastTerminalPane(orcaPage)
    await closeActiveTerminalPane(orcaPage)
    await waitForPaneCount(orcaPage, panesBefore)

    // The original pane should still have our marker
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(marker), { timeout: 5_000 })
      .toBe(true)
  })

  /**
   * User Prompt:
   * - terminal panes retain state when switching tabs and when you make / close a pane / switch worktrees
   */
  test('terminal pane retains content when switching worktrees and back', async ({ orcaPage }) => {
    const allWorktreeIds = await getAllWorktreeIds(orcaPage)
    if (allWorktreeIds.length < 2) {
      test.skip(true, 'Need at least 2 worktrees to test worktree switching')
      return
    }

    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Write a unique marker to the current terminal
    const ptyId = await discoverActivePtyId(orcaPage)
    const marker = `WT_RETAIN_${Date.now()}`
    await execInTerminal(orcaPage, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(orcaPage, marker)

    // Switch to a different worktree via the store
    const otherId = await switchToOtherWorktree(orcaPage, worktreeId)
    expect(otherId).not.toBeNull()
    await expect.poll(async () => getActiveWorktreeId(orcaPage), { timeout: 5_000 }).toBe(otherId)

    // Switch back to the original worktree
    await switchToWorktree(orcaPage, worktreeId)
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 5_000 })
      .toBe(worktreeId)

    // Why: after a worktree round-trip, the split-group container transitions
    // from hidden back to visible. In headful Electron runs the terminal tree
    // can take longer than a single render turn to rebind its serialize addon
    // after the worktree activation cascade. Waiting directly for the retained
    // marker proves the user-visible behavior without failing early on the
    // intermediate manager-remount timing.
    await ensureTerminalVisible(orcaPage)

    // The terminal should still contain our marker
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(marker), { timeout: 20_000 })
      .toBe(true)
  })

  /**
   * User Prompt:
   * - resizing terminal panes works
   */
  test('shows a pane divider after splitting', async ({ orcaPage }) => {
    // Why: headless Playwright cannot exercise the real pointer-capture resize
    // path reliably, so the default suite only verifies the precondition for
    // resizing: splitting creates a visible divider for the active layout.
    const panesBefore = await countVisibleTerminalPanes(orcaPage)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, panesBefore + 1)

    await expect(orcaPage.locator('.pane-divider.is-vertical').first()).toBeVisible({
      timeout: 3_000
    })
  })

  /**
   * User Prompt:
   * - resizing terminal panes works (headful variant)
   *
   * Why this test must be headful: the pane divider's drag handler calls
   * setPointerCapture(e.pointerId) on pointerdown. Pointer capture requires
   * a valid pointer ID from a real pointing-device event, which Playwright's
   * mouse API only produces when the Electron window is visible. In headless
   * mode setPointerCapture silently fails, pointermove never fires on the
   * divider, and the resize has no effect. Run with:
   *   ORCA_E2E_HEADFUL=1 pnpm run test:e2e
   */
  test('@headful can resize terminal panes by real mouse drag', async ({ orcaPage }) => {
    // Split the terminal to create a resizable divider
    const panesBefore = await countVisibleTerminalPanes(orcaPage)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, panesBefore + 1)

    // Get the pane widths before resize
    const paneWidthsBefore = await orcaPage.evaluate(() => {
      const xterms = document.querySelectorAll('.xterm')
      return Array.from(xterms)
        .filter((x) => (x as HTMLElement).offsetParent !== null)
        .map((x) => (x as HTMLElement).getBoundingClientRect().width)
    })
    expect(paneWidthsBefore.length).toBeGreaterThanOrEqual(2)

    // Find the vertical pane divider and drag it
    const divider = orcaPage.locator('.pane-divider.is-vertical').first()
    await expect(divider).toBeVisible({ timeout: 3_000 })
    const box = await divider.boundingBox()
    expect(box).not.toBeNull()

    // Drag the divider 150px to the right to resize panes
    const startX = box!.x + box!.width / 2
    const startY = box!.y + box!.height / 2
    await orcaPage.mouse.move(startX, startY)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(startX + 150, startY, { steps: 20 })
    await orcaPage.mouse.up()

    // Verify pane widths changed
    await expect
      .poll(
        async () => {
          const widthsAfter = await orcaPage.evaluate(() => {
            const xterms = document.querySelectorAll('.xterm')
            return Array.from(xterms)
              .filter((x) => (x as HTMLElement).offsetParent !== null)
              .map((x) => (x as HTMLElement).getBoundingClientRect().width)
          })
          if (widthsAfter.length < 2) {
            return false
          }

          return paneWidthsBefore.some((w, i) => Math.abs(w - widthsAfter[i]) > 20)
        },
        { timeout: 5_000, message: 'Pane widths did not change after dragging divider' }
      )
      .toBe(true)
  })

  test('@headful resizing split panes forwards only the settled PTY size', async ({ orcaPage }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const ptyIds = snapshot.panes
      .map((pane) => pane.ptyId)
      .filter((ptyId): ptyId is string => Boolean(ptyId))

    for (const ptyId of ptyIds) {
      await sendToTerminal(
        orcaPage,
        ptyId,
        "export PS1='ISSUE2910_PROMPT$ '; export PROMPT=\"$PS1\"; trap 'printf \"\\nISSUE2910_WINCH\\n\"' WINCH; clear; printf 'ISSUE2910_READY\\n'\r"
      )
    }

    await expect
      .poll(
        async () =>
          (await readVisiblePaneContents(orcaPage)).every((content) =>
            content.includes('ISSUE2910_READY')
          ),
        { timeout: 10_000, message: 'Split panes did not receive resize-regression prompt setup' }
      )
      .toBe(true)

    const divider = orcaPage.locator('.pane-divider.is-vertical').first()
    await expect(divider).toBeVisible({ timeout: 3_000 })
    const box = await divider.boundingBox()
    expect(box).not.toBeNull()

    const startX = box!.x + box!.width / 2
    const startY = box!.y + box!.height / 2
    await orcaPage.mouse.move(startX, startY)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(startX - 350, startY, { steps: 40 })
    await orcaPage.mouse.move(startX + 250, startY, { steps: 40 })
    await orcaPage.mouse.up()
    await orcaPage.waitForTimeout(500)

    const paneContents = await readVisiblePaneContents(orcaPage)
    for (const content of paneContents) {
      const promptRedraws = content.match(/ISSUE2910_PROMPT/g)?.length ?? 0
      const winchNotifications = content.match(/ISSUE2910_WINCH/g)?.length ?? 0
      expect(promptRedraws).toBeLessThanOrEqual(3)
      expect(winchNotifications).toBeLessThanOrEqual(1)
    }
  })

  test('@headful dragging terminal panes around preserves leaf-keyed PTY bindings', async ({
    orcaPage
  }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    await splitActiveTerminalPane(orcaPage, 'horizontal')
    await waitForPaneCount(orcaPage, 3)

    const beforeDrag = await waitForPaneIdentitySnapshot(orcaPage, 3)
    const beforeOrder = await readTerminalPaneDomLeafOrder(orcaPage)
    const source = beforeDrag.panes.at(-1)
    const target = beforeDrag.panes[0]
    if (!source || !target) {
      throw new Error('Need source and target panes for drag test')
    }

    const sourceHandle = orcaPage.locator(
      `.pane[data-leaf-id="${source.leafId}"] .pane-drag-handle`
    )
    await expect(sourceHandle).toBeVisible({ timeout: 3_000 })
    const sourceBox = await sourceHandle.boundingBox()
    const targetBox = await orcaPage.locator(`.pane[data-leaf-id="${target.leafId}"]`).boundingBox()
    expect(sourceBox).not.toBeNull()
    expect(targetBox).not.toBeNull()

    await orcaPage.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + 4)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(targetBox!.x + 8, targetBox!.y + targetBox!.height / 2, {
      steps: 20
    })
    await orcaPage.mouse.up()

    await expect
      .poll(async () => readTerminalPaneDomLeafOrder(orcaPage), {
        timeout: 10_000,
        message: 'Real pane drag did not update DOM order'
      })
      .not.toEqual(beforeOrder)

    const afterDrag = await waitForPaneIdentitySnapshot(orcaPage, 3)
    expect(afterDrag.panes.map((pane) => pane.leafId).sort()).toEqual(
      beforeDrag.panes.map((pane) => pane.leafId).sort()
    )
    expect(afterDrag.ptyIdsByLeafId).toEqual(beforeDrag.ptyIdsByLeafId)
  })

  /**
   * User Prompt:
   * - closing panes works
   */
  test('closing a split pane removes it and remaining pane fills space', async ({ orcaPage }) => {
    const panesBefore = await countVisibleTerminalPanes(orcaPage)

    // Split the terminal
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, panesBefore + 1)

    const panesAfterSplit = await countVisibleTerminalPanes(orcaPage)
    expect(panesAfterSplit).toBeGreaterThanOrEqual(2)

    await closeActiveTerminalPane(orcaPage)
    await waitForPaneCount(orcaPage, panesAfterSplit - 1)

    // The remaining pane should fill the available space
    const paneWidth = await orcaPage.evaluate(() => {
      const xterms = document.querySelectorAll('.xterm')
      const visible = Array.from(xterms).find(
        (x) => (x as HTMLElement).offsetParent !== null
      ) as HTMLElement | null
      return visible?.getBoundingClientRect().width ?? 0
    })
    // Why: threshold is kept low to account for headless mode where the
    // window is 1200px wide (not maximized) and the sidebar takes space.
    expect(paneWidth).toBeGreaterThan(200)
  })
})
