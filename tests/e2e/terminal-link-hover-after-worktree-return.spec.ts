import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

/**
 * Repro for: a clickable terminal link (file path, URL, …) becomes dead after
 * switching to another worktree and returning, until the user scrolls the
 * terminal a little.
 *
 * xterm's Linkifier only re-runs link providers on mousemove when the hovered
 * buffer cell changes vs its `_lastBufferCell` cache. Hiding the surface fires
 * mouseleave (clearing the current link) but leaves that cache, so returning
 * the pointer to the same cell short-circuits and the link is never
 * re-established — `currentLink` stays null. File-path links are the worst case
 * because their geometry click fallback does not compensate after reveal.
 */
type HoverProbe = { col: number; row: number; tabId: string }

async function locateHoverProbe(page: Page, needle: string): Promise<HoverProbe> {
  return page.evaluate((needle) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId ?? null
    const tabId =
      state?.activeTabType === 'terminal'
        ? (state?.activeTabId ?? null)
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!tabId || !pane) {
      throw new Error('active terminal pane unavailable')
    }
    const terminal = pane.terminal
    const buffer = terminal.buffer.active
    let hit: { row: number; col: number } | null = null
    for (let row = 0; row < terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row)
      if (!line) {
        continue
      }
      const idx = line.translateToString(true).indexOf(needle)
      if (idx >= 0) {
        hit = { row, col: idx }
        break
      }
    }
    if (!hit) {
      throw new Error('link text not visible in terminal viewport')
    }
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) {
      throw new Error('xterm-screen element unavailable')
    }
    // Aim at the middle of the link text so the pointer lands squarely inside
    // the link range regardless of rounding.
    return {
      col: hit.col + Math.floor(needle.length / 2),
      row: hit.row,
      tabId
    }
  }, needle)
}

/**
 * Dispatch a hover mousemove at the probe coordinates and return the text of
 * the link the linkifier considers active (or null). Callers poll this because
 * Orca's file-path provider resolves link candidates asynchronously.
 */
async function hoverAndReadActiveLinkText(page: Page, probe: HoverProbe): Promise<string | null> {
  await page.evaluate(({ col, row, tabId }) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!pane || !screen) {
      throw new Error('xterm-screen element unavailable')
    }
    const rect = screen.getBoundingClientRect()
    const clientX = rect.left + (col + 0.5) * (rect.width / pane.terminal.cols)
    const clientY = rect.top + (row + 0.5) * (rect.height / pane.terminal.rows)
    screen.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX, clientY })
    )
  }, probe)
  return page.evaluate(({ tabId }) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const core = pane?.terminal as unknown as
      | { _core?: { linkifier?: { currentLink?: { link?: { text?: string } } } } }
      | undefined
    return core?._core?.linkifier?.currentLink?.link?.text ?? null
  }, probe)
}

async function readTerminalCursor(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    return screen ? getComputedStyle(screen).cursor : null
  }, tabId)
}

async function isTerminalSurfaceVisible(page: Page, tabId: string): Promise<boolean> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return Boolean(pane?.container.isConnected && pane.container.getClientRects().length > 0)
  }, tabId)
}

async function activateHoveredLink(page: Page, probe: HoverProbe): Promise<void> {
  await page.evaluate(({ col, row, tabId }) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!pane || !screen) {
      throw new Error('xterm-screen element unavailable')
    }
    const rect = screen.getBoundingClientRect()
    const clientX = rect.left + (col + 0.5) * (rect.width / pane.terminal.cols)
    const clientY = rect.top + (row + 0.5) * (rect.height / pane.terminal.rows)
    const isMac = navigator.userAgent.includes('Mac')
    const modifier = { metaKey: isMac, ctrlKey: !isMac }
    screen.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX,
        clientY,
        ...modifier
      })
    )
    screen.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY,
        ...modifier
      })
    )
  }, probe)
}

async function dispatchScreenMouseLeave(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    // Mimics the pointer leaving as the surface hides on a worktree switch:
    // clears the linkifier's current link but keeps its cell cache.
    screen?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true }))
  }, tabId)
}

async function activeWorktreePath(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const id = state?.activeWorktreeId
    return (
      Object.values(state?.worktreesByRepo ?? {})
        .flat()
        .find((w) => w.id === id)?.path ?? ''
    )
  })
}

/**
 * Drive the full repro and assert the link re-establishes on hover after
 * returning to the worktree. `contains` accommodates the file provider's
 * display text differing slightly from the raw echoed token.
 */
async function assertLinkRecoversAfterReturn(
  page: Page,
  args: {
    firstWorktreeId: string
    secondWorktreeId: string
    needle: string
    expectContains: string
  }
): Promise<HoverProbe> {
  const probe = await locateHoverProbe(page, args.needle)

  // Baseline: hovering establishes the link before any switch.
  await expect
    .poll(() => hoverAndReadActiveLinkText(page, probe), {
      timeout: 5_000,
      message: 'baseline hover never established the link'
    })
    .toContain(args.expectContains)

  await dispatchScreenMouseLeave(page, probe.tabId)
  await switchToWorktree(page, args.secondWorktreeId)
  await waitForActiveTerminalManager(page, 30_000)
  // Wait for React to commit the intermediate hidden surface; switching back
  // before that commit would batch away the lifecycle transition under test.
  await expect.poll(() => isTerminalSurfaceVisible(page, probe.tabId)).toBe(false)

  await switchToWorktree(page, args.firstWorktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await expect.poll(() => isTerminalSurfaceVisible(page, probe.tabId)).toBe(true)

  // Hover the SAME cell without scrolling. Pre-fix this never re-establishes
  // the link (dead until a scroll); post-fix the reveal reset re-linkifies.
  await expect
    .poll(() => hoverAndReadActiveLinkText(page, probe), {
      timeout: 5_000,
      message: 'link did not re-establish on hover after returning to the worktree'
    })
    .toContain(args.expectContains)

  // The pointer cursor is the user-visible hover affordance; currentLink is
  // also checked above because it is the backing state xterm requires to click.
  await expect.poll(() => readTerminalCursor(page, probe.tabId)).toBe('pointer')
  return probe
}

test.describe('Terminal link hover after worktree return', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('re-establishes a file-path link on hover after switching worktrees and back', async ({
    orcaPage
  }) => {
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'link-hover repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)

    const worktreePath = await activeWorktreePath(orcaPage)
    const fileName = `orca-linkfile-${randomUUID().slice(0, 8)}.txt`
    const filePath = path.join(worktreePath, fileName)
    writeFileSync(filePath, 'orca file link target\n')
    const needle = `./${fileName}`

    try {
      await sendToTerminal(orcaPage, ptyId, `echo ${needle}\r`)
      await expect
        .poll(() => getTerminalContent(orcaPage, 4000), {
          timeout: 10_000,
          message: 'file-link fixture did not reach the terminal buffer'
        })
        .toContain(fileName)

      const probe = await assertLinkRecoversAfterReturn(orcaPage, {
        firstWorktreeId,
        secondWorktreeId,
        needle,
        expectContains: fileName
      })
      await activateHoveredLink(orcaPage, probe)
      // The editor header is the user-visible result of a successful terminal
      // link activation; store state alone could pass with a blank editor.
      await expect(orcaPage.locator('.editor-header-path').first()).toContainText(fileName, {
        timeout: 20_000
      })
    } finally {
      await orcaPage.evaluate((filePath) => {
        const state = window.__store?.getState()
        if (state?.openFiles.some((file) => file.filePath === filePath)) {
          state.closeFile(filePath)
        }
      }, filePath)
      rmSync(filePath, { force: true })
    }
  })

  test('re-establishes a URL link on hover after switching worktrees and back', async ({
    orcaPage
  }) => {
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'link-hover repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)

    const url = `https://example.com/orca-link-${randomUUID()}`
    await sendToTerminal(orcaPage, ptyId, `echo ${url}\r`)
    await expect
      .poll(() => getTerminalContent(orcaPage, 4000), {
        timeout: 10_000,
        message: 'URL fixture did not reach the terminal buffer'
      })
      .toContain(url)

    await assertLinkRecoversAfterReturn(orcaPage, {
      firstWorktreeId,
      secondWorktreeId,
      needle: url,
      expectContains: url
    })
  })
})
