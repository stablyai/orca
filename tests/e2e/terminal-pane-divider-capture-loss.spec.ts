import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { ensureTerminalVisible } from './helpers/store'

type PaneGeometry = {
  width: number
  flex: string
  cols: number | null
  rows: number | null
  proposed: { cols: number; rows: number } | null
}

type DividerGeometry = {
  first: PaneGeometry
  second: PaneGeometry
}

test.use({ seedTestRepo: false })

async function setFullscreen(electronApp: ElectronApplication, page: Page): Promise<void> {
  await expect
    .poll(async () => {
      try {
        return await electronApp.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          if (!window) {
            return false
          }
          if (window.isMinimized()) {
            window.restore()
          }
          window.show()
          window.focus()
          window.setFullScreen(true)
          return window.isFullScreen()
        })
      } catch {
        return false
      }
    })
    .toBe(true)
  await expect.poll(() => page.evaluate(() => innerWidth >= 1000 && innerHeight >= 700)).toBe(true)
  await page.waitForTimeout(1200)
}

async function addTestRepo(page: Page, repoPath: string): Promise<void> {
  const repoId = await page.evaluate(async (path) => {
    const result = await window.api.repos.add({ path })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, repoPath)
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const store = window.__store
        if (!store) {
          return false
        }
        await store.getState().fetchRepos()
        await store.getState().fetchWorktrees(id)
        const worktree = store
          .getState()
          .worktreesByRepo[id]?.find((candidate) => candidate.isMainWorktree)
        if (!worktree) {
          return false
        }
        store.getState().setActiveWorktree(worktree.id)
        return true
      }, repoId)
    )
    .toBe(true)
}

async function readDividerGeometry(page: Page): Promise<DividerGeometry> {
  return page.evaluate(() => {
    const divider = document.querySelector<HTMLElement>('.pane-divider.is-vertical')
    const firstElement = divider?.previousElementSibling as HTMLElement | null
    const secondElement = divider?.nextElementSibling as HTMLElement | null
    if (!divider || !firstElement || !secondElement) {
      throw new Error('Divider unavailable')
    }
    const readPane = (element: HTMLElement): PaneGeometry => {
      const paneElement = element.matches('.pane[data-pty-id]')
        ? element
        : element.querySelector<HTMLElement>('.pane[data-pty-id]')
      const ptyId = paneElement?.dataset.ptyId
      const pane = ptyId
        ? Array.from(window.__paneManagers?.values() ?? [])
            .flatMap((manager) => manager.getPanes())
            .find((candidate) => candidate.container.dataset.ptyId === ptyId)
        : null
      let proposed = null
      try {
        proposed = pane?.fitAddon.proposeDimensions() ?? null
      } catch {
        proposed = null
      }
      return {
        width: element.getBoundingClientRect().width,
        flex: element.style.flex,
        cols: pane?.terminal.cols ?? null,
        rows: pane?.terminal.rows ?? null,
        proposed
      }
    }
    return { first: readPane(firstElement), second: readPane(secondElement) }
  })
}

function gridsMatch(geometry: DividerGeometry): boolean {
  return [geometry.first, geometry.second].every(
    (pane) =>
      pane.proposed !== null && pane.cols === pane.proposed.cols && pane.rows === pane.proposed.rows
  )
}

test('@headful keeps resizing after the divider loses pointer capture', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  await setFullscreen(electronApp, orcaPage)
  await addTestRepo(orcaPage, testRepoPath)
  await ensureTerminalVisible(orcaPage, 30_000)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneCount(orcaPage, 2, 30_000)

  const divider = orcaPage.locator('.pane-divider.is-vertical').first()
  await expect(divider).toBeVisible()
  const box = await divider.boundingBox()
  if (!box) {
    throw new Error('Divider has no bounding box')
  }
  await divider.evaluate((element) => {
    element.dataset.captureLossCount = '0'
    element.addEventListener('pointerdown', (event) => {
      element.dataset.captureLossPointerId = String(event.pointerId)
    })
    element.addEventListener('lostpointercapture', () => {
      element.dataset.captureLossCount = String(Number(element.dataset.captureLossCount ?? '0') + 1)
    })
  })

  const before = await readDividerGeometry(orcaPage)
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await orcaPage.mouse.move(startX, startY)
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(startX + 140, startY, { steps: 10 })
  await expect
    .poll(async () =>
      Math.abs((await readDividerGeometry(orcaPage)).first.width - before.first.width)
    )
    .toBeGreaterThan(80)

  // Why: this is the real browser event observed during field failures; later
  // window-level pointer events must remain authoritative after capture drops.
  await divider.evaluate((element) => {
    const pointerId = Number(element.dataset.captureLossPointerId)
    if (!Number.isInteger(pointerId) || !element.hasPointerCapture(pointerId)) {
      throw new Error('Divider did not acquire pointer capture')
    }
    element.releasePointerCapture(pointerId)
  })
  await expect
    .poll(() => divider.evaluate((element) => Number(element.dataset.captureLossCount ?? '0')))
    .toBe(1)

  await orcaPage.mouse.move(startX + 260, startY, { steps: 10 })
  await orcaPage.mouse.up()
  await expect.poll(async () => gridsMatch(await readDividerGeometry(orcaPage))).toBe(true)
  const after = await readDividerGeometry(orcaPage)
  await testInfo.attach('divider-capture-loss-geometry', {
    body: Buffer.from(JSON.stringify({ before, after }, null, 2)),
    contentType: 'application/json'
  })

  expect(Math.abs(after.first.width - before.first.width)).toBeGreaterThan(180)
  expect(Math.abs(after.second.width - before.second.width)).toBeGreaterThan(180)
  expect(after.first.flex).not.toBe(before.first.flex)
  expect(after.second.flex).not.toBe(before.second.flex)
})
