import { randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

type LinkProbe = {
  tabId: string
  col: number
  row: number
}

type TooltipState = {
  display: string
  text: string
  currentLinkText: string | null
  cursor: string
  paneBottom: number
  terminalBottom: number
  tooltipTop: number
  tooltipBottom: number
  tooltipHeight: number
}

async function locateUrl(page: Page, url: string): Promise<LinkProbe | null> {
  return page.evaluate((url) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? (state.activeTabId ?? null)
        : worktreeId
          ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!tabId || !pane) {
      return null
    }

    const buffer = pane.terminal.buffer.active
    for (let row = 0; row < pane.terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row)
      const col = line?.translateToString(true).indexOf(url) ?? -1
      if (col >= 0) {
        return {
          tabId,
          col: col + Math.floor(url.length / 2),
          row
        }
      }
    }
    return null
  }, url)
}

async function moveToLink(page: Page, probe: LinkProbe): Promise<void> {
  await page.evaluate(({ col, row, tabId }) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!pane || !screen) {
      throw new Error('xterm-screen element unavailable')
    }
    const rect = screen.getBoundingClientRect()
    screen.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + (col + 0.5) * (rect.width / pane.terminal.cols),
        clientY: rect.top + (row + 0.5) * (rect.height / pane.terminal.rows)
      })
    )
  }, probe)
}

async function readTooltipState(page: Page, tabId: string): Promise<TooltipState> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!pane || !screen) {
      throw new Error('terminal pane unavailable')
    }

    const linkifier = (
      pane.terminal as unknown as {
        _core?: { linkifier?: { currentLink?: { link?: { text?: string } } } }
      }
    )._core?.linkifier
    const paneRect = pane.container.getBoundingClientRect()
    const terminalRect = pane.terminal.element?.parentElement?.getBoundingClientRect()
    const tooltipRect = pane.linkTooltip.getBoundingClientRect()

    return {
      display: pane.linkTooltip.style.display,
      text: pane.linkTooltip.textContent ?? '',
      currentLinkText: linkifier?.currentLink?.link?.text ?? null,
      cursor: getComputedStyle(screen).cursor,
      paneBottom: paneRect.bottom,
      terminalBottom: terminalRect?.bottom ?? 0,
      tooltipTop: tooltipRect.top,
      tooltipBottom: tooltipRect.bottom,
      tooltipHeight: tooltipRect.height
    }
  }, tabId)
}

async function captureProof(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(name), animations: 'disabled' })
}

test.describe('Issue #12656 terminal link tooltip', () => {
  test('clears hover state without permanently shrinking the terminal', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)

    const url = `https://example.com/orca-issue-12656-${randomUUID().slice(0, 8)}`
    await sendToTerminal(
      orcaPage,
      ptyId,
      `printf 'issue-12656-output-%02d\\n' $(seq 1 64); printf '${url}\\n'\r`
    )
    await waitForTerminalOutput(orcaPage, url)

    let probe: LinkProbe | null = null
    await expect
      .poll(
        async () => {
          probe = await locateUrl(orcaPage, url)
          return probe
        },
        { timeout: 5_000, message: 'URL did not become visible in the terminal viewport' }
      )
      .not.toBeNull()
    if (!probe) {
      throw new Error('URL probe disappeared before hover')
    }
    const idle = await readTooltipState(orcaPage, probe.tabId)
    expect(Math.abs(idle.paneBottom - idle.terminalBottom)).toBeLessThanOrEqual(1)
    await expect
      .poll(async () => {
        await moveToLink(orcaPage, probe)
        return readTooltipState(orcaPage, probe.tabId)
      })
      .toMatchObject({ display: '', currentLinkText: url })

    const hovered = await readTooltipState(orcaPage, probe.tabId)
    expect(hovered.text).toContain(url)
    expect(hovered.tooltipHeight).toBeGreaterThan(0)
    expect(Math.abs(hovered.paneBottom - hovered.terminalBottom)).toBeLessThanOrEqual(1)
    expect(Math.abs(hovered.paneBottom - hovered.tooltipBottom)).toBeLessThanOrEqual(1)
    expect(hovered.tooltipTop).toBeLessThan(hovered.terminalBottom)
    await captureProof(orcaPage, testInfo, 'issue-12656-fixed-hover.png')

    await orcaPage.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect
      .poll(() => readTooltipState(orcaPage, probe.tabId))
      .toMatchObject({ display: 'none', currentLinkText: null, cursor: 'text' })
    const cleared = await readTooltipState(orcaPage, probe.tabId)
    expect(Math.abs(cleared.paneBottom - cleared.terminalBottom)).toBeLessThanOrEqual(1)
    await captureProof(orcaPage, testInfo, 'issue-12656-fixed-after-blur.png')

    await expect.poll(() => getTerminalContent(orcaPage)).toContain(url)
  })
})
