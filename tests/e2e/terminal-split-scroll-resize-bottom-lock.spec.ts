import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

type SplitPaneSnapshot = {
  baseY: number
  cols: number
  firstVisibleLine: string
  firstVisibleLineIsWrapped: boolean
  ptyId: string
  rows: number
  viewportY: number
}

function transcriptFixture(runId: string): string {
  return `
for (let row = 0; row < 420; row += 1) {
  const marker = 'SPLIT_CODEX_HISTORY_${runId}_' + String(row).padStart(4, '0')
  process.stdout.write(marker + ' assistant response ' + 'x'.repeat(92) + '\\r\\n')
}
process.stdout.write('SPLIT_CODEX_HISTORY_${runId}_READY\\r\\n')
process.stdout.on('resize', () => {
  process.stdout.write('SPLIT_CODEX_HISTORY_${runId}_RESIZED\\r\\n')
})
let liveRow = 0
setInterval(() => {
  process.stdout.write('SPLIT_CODEX_LIVE_${runId}_' + String(liveRow).padStart(4, '0') + '\\r\\n')
  liveRow += 1
}, 20)
`
}

async function readFirstSplitPane(page: Page): Promise<SplitPaneSnapshot> {
  return page.evaluate(() => {
    const divider = document.querySelector<HTMLElement>('.pane-divider.is-vertical')
    const subtree = divider?.previousElementSibling as HTMLElement | null
    const paneElement = subtree?.matches('.pane[data-pty-id]')
      ? subtree
      : subtree?.querySelector<HTMLElement>('.pane[data-pty-id]')
    const ptyId = paneElement?.dataset.ptyId
    const pane = ptyId
      ? Array.from(window.__paneManagers?.values() ?? [])
          .flatMap((manager) => manager.getPanes())
          .find((candidate) => candidate.container.dataset.ptyId === ptyId)
      : null
    if (!pane || !ptyId) {
      throw new Error('First split terminal pane unavailable')
    }
    const buffer = pane.terminal.buffer.active
    return {
      baseY: buffer.baseY,
      cols: pane.terminal.cols,
      firstVisibleLine: buffer.getLine(buffer.viewportY)?.translateToString(true) ?? '',
      firstVisibleLineIsWrapped: buffer.getLine(buffer.viewportY)?.isWrapped ?? false,
      ptyId,
      rows: pane.terminal.rows,
      viewportY: buffer.viewportY
    }
  })
}

async function pinFirstSplitPaneToMarker(page: Page, marker: string): Promise<void> {
  await page.evaluate((searchMarker) => {
    const divider = document.querySelector<HTMLElement>('.pane-divider.is-vertical')
    const subtree = divider?.previousElementSibling as HTMLElement | null
    const paneElement = subtree?.matches('.pane[data-pty-id]')
      ? subtree
      : subtree?.querySelector<HTMLElement>('.pane[data-pty-id]')
    const ptyId = paneElement?.dataset.ptyId
    const pane = ptyId
      ? Array.from(window.__paneManagers?.values() ?? [])
          .flatMap((manager) => manager.getPanes())
          .find((candidate) => candidate.container.dataset.ptyId === ptyId)
      : null
    if (!pane) {
      throw new Error('First split terminal pane unavailable')
    }
    pane.terminal.options.screenReaderMode = true
    const target = pane.container.querySelector<HTMLElement>('.xterm') ?? pane.container
    target.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaY: -1_200
      })
    )
    const buffer = pane.terminal.buffer.active
    for (let lineY = 0; lineY < buffer.length; lineY += 1) {
      if (buffer.getLine(lineY)?.translateToString(true).includes(searchMarker)) {
        pane.terminal.scrollToLine(lineY + 1)
        pane.terminal.refresh(0, pane.terminal.rows - 1)
        pane.container
          .querySelector<HTMLElement>('.xterm-viewport')
          ?.dispatchEvent(new Event('scroll', { bubbles: true }))
        return
      }
    }
    throw new Error(`Terminal marker not found: ${searchMarker}`)
  }, marker)
}

async function dragFirstDividerBy(page: Page, deltaX: number): Promise<void> {
  const divider = page.locator('.pane-divider.is-vertical').first()
  const box = await divider.boundingBox()
  if (!box) {
    throw new Error('Split divider has no bounding box')
  }
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + deltaX, startY, { steps: 4 })
  await page.mouse.up()
}

test('@headful bottom-locks a pinned live Codex continuation after a tiny split widen', async ({
  orcaPage,
  testRepoPath
}, testInfo: TestInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneCount(orcaPage, 2, 30_000)

  const initialPane = await readFirstSplitPane(orcaPage)
  await dragFirstDividerBy(orcaPage, 8)
  await expect
    .poll(() => readFirstSplitPane(orcaPage).then((snapshot) => snapshot.cols), {
      timeout: 10_000,
      message: 'Immediate post-split divider drag did not resize the terminal'
    })
    .not.toBe(initialPane.cols)
  const immediatelyResized = await readFirstSplitPane(orcaPage)
  expect(immediatelyResized.viewportY).toBe(immediatelyResized.baseY)
  await waitForPtyShellEcho(orcaPage, initialPane.ptyId, 15_000)
  const runId = randomUUID()
  const scriptPath = path.join(testRepoPath, `.orca-split-scroll-resize-${runId}.mjs`)
  writeFileSync(scriptPath, transcriptFixture(runId))

  try {
    await sendToTerminal(orcaPage, initialPane.ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
    await expect
      .poll(() => readFirstSplitPane(orcaPage).then((snapshot) => snapshot.baseY), {
        timeout: 15_000,
        message: 'Split-pane transcript did not fill scrollback'
      })
      .toBeGreaterThan(400)

    const pinMarker = `SPLIT_CODEX_HISTORY_${runId}_0249`
    await pinFirstSplitPaneToMarker(orcaPage, pinMarker)
    const paneDom = orcaPage
      .locator('.pane-divider.is-vertical')
      .first()
      .locator('xpath=preceding-sibling::*[1]')
      .locator('.xterm-accessibility-tree')
    await expect
      .poll(() =>
        readFirstSplitPane(orcaPage).then((snapshot) => snapshot.firstVisibleLineIsWrapped)
      )
      .toBe(true)
    const before = await readFirstSplitPane(orcaPage)
    expect(before.firstVisibleLine).not.toContain(pinMarker)
    expect(before.firstVisibleLineIsWrapped).toBe(true)
    expect(before.viewportY).toBeLessThan(before.baseY)
    await orcaPage.screenshot({
      path: testInfo.outputPath('split-scroll-resize-before.png'),
      fullPage: true
    })

    await dragFirstDividerBy(orcaPage, 12)

    await expect
      .poll(() => readFirstSplitPane(orcaPage).then((snapshot) => snapshot.cols), {
        timeout: 10_000,
        message: 'Tiny divider drag did not widen the target terminal grid'
      })
      .toBeGreaterThan(before.cols)
    const after = await readFirstSplitPane(orcaPage)
    expect(after.viewportY).toBe(after.baseY)
    await expect(paneDom).toContainText(`SPLIT_CODEX_LIVE_${runId}_`, {
      timeout: 10_000
    })
    await orcaPage.screenshot({
      path: testInfo.outputPath('split-scroll-resize-after.png'),
      fullPage: true
    })
  } finally {
    rmSync(scriptPath, { force: true })
  }
})
