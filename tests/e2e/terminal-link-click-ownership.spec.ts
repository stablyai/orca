import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

import {
  readPanelNavigationObserver,
  startPanelNavigationObserver
} from './helpers/plugin-panel-navigation-observer'

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/terminal-link-mouse-owner-fixture.cjs'
)
const LINK = 'https://example.com/sta-3888'
const OSC_LINK_TEXT = 'STA_3888_OSC_LINK'

type LinkMode = 'http' | 'osc'

async function startMouseAwareLinkFixture(
  orcaPage: Page,
  testInfo: TestInfo,
  linkMode: LinkMode = 'http',
  inputLogPath?: string
): Promise<{ mouseLogPath: string; ptyId: string; target: Locator }> {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  // DOM rendering exposes the actual terminal labels for semantic pointer delivery.
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ terminalGpuAcceleration: 'off' })
  })
  await waitForActiveTerminalManager(orcaPage)
  await waitForPaneCount(orcaPage, 1)

  const ptyId = await waitForActivePanePtyId(orcaPage)
  const mouseLogPath = testInfo.outputPath('child-mouse-reports.log')
  await execInTerminal(
    orcaPage,
    ptyId,
    `node ${JSON.stringify(FIXTURE_PATH)} ${JSON.stringify(mouseLogPath)} ${linkMode}${inputLogPath ? ` ${JSON.stringify(inputLogPath)}` : ''}`
  )
  const renderedLinkText = linkMode === 'osc' ? OSC_LINK_TEXT : LINK
  await waitForTerminalOutput(orcaPage, 'LINK_MOUSE_READY')

  const target = orcaPage
    .locator('.xterm:visible .xterm-rows > div')
    .filter({ hasText: renderedLinkText })
    .locator('span')
    .filter({ hasText: renderedLinkText })
    .first()
  await expect(target).toBeVisible()
  await expect.poll(() => waitForActivePanePtyId(orcaPage)).toBe(ptyId)
  const tracking = await target.evaluate((label, linkText) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId = worktreeId ? state?.activeTabIdByWorktree?.[worktreeId] : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? null
    const terminal = pane?.terminal
    const screen = terminal?.element?.querySelector('.xterm-screen')
    if (!terminal || !screen || !label.isConnected || !terminal.element?.contains(label)) {
      throw new Error('Intended connected terminal label unavailable')
    }
    const labelRect = label.getBoundingClientRect()
    const rect = screen.getBoundingClientRect()
    const column = Math.floor(
      (labelRect.left + labelRect.width / 2 - rect.left) / (rect.width / terminal.cols)
    )
    const row = Math.floor(
      (labelRect.top + labelRect.height / 2 - rect.top) / (rect.height / terminal.rows)
    )
    const text = terminal.buffer.active
      .getLine(terminal.buffer.active.viewportY + row)
      ?.translateToString(false)
    const start = text?.indexOf(linkText) ?? -1
    if (
      row < 0 ||
      row >= terminal.rows ||
      start < 0 ||
      column < start ||
      column >= start + linkText.length
    ) {
      throw new Error('Semantic label center is outside the actual rendered link range')
    }
    return terminal.modes.mouseTrackingMode
  }, renderedLinkText)
  expect(tracking).not.toBe('none')
  return { mouseLogPath, ptyId, target }
}

function childMouseReportCount(mouseLogPath: string): number {
  if (!existsSync(mouseLogPath)) {
    return 0
  }
  return readFileSync(mouseLogPath, 'utf8').trim().split(/\s+/).filter(Boolean).length
}

async function expectChildMouseReports(mouseLogPath: string): Promise<void> {
  await expect
    .poll(() => childMouseReportCount(mouseLogPath), { timeout: 5_000 })
    .toBeGreaterThan(0)
}

async function expectOrcaOwnedMouseOutcome(
  mouseLogPath: string,
  reportsBeforeClick = 0
): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
  expect(childMouseReportCount(mouseLogPath)).toBe(reportsBeforeClick)
}

async function openLegacyDisabledLinkSettings(orcaPage: Page): Promise<void> {
  await orcaPage.evaluate(() => {
    void window.__store?.getState().updateSettings({ terminalLinkActionPopoverEnabled: false })
  })
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__store?.getState().settings?.terminalLinkActionPopoverEnabled)
    )
    .toBe(false)
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.openSettingsPage()
    state?.openSettingsTarget({ pane: 'browser', repoId: null })
  })
}

test.describe('terminal link click ownership', () => {
  test('selecting Actions reenables a legacy-disabled popover and survives renderer reload', async ({
    orcaPage
  }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(orcaPage, testInfo)
    await openLegacyDisabledLinkSettings(orcaPage)

    const choices = orcaPage.getByRole('radiogroup', { name: 'Plain click URL behavior' })
    await expect(choices.getByRole('radio', { name: 'Leave to terminal' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await choices.getByRole('radio', { name: 'Actions', exact: true }).click()
    await expect(choices.getByRole('radio', { name: 'Actions', exact: true })).toHaveAttribute(
      'aria-checked',
      'true'
    )

    await orcaPage.reload()
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsPage()
      state?.openSettingsTarget({ pane: 'browser', repoId: null })
    })
    await expect(choices.getByRole('radio', { name: 'Actions', exact: true })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await orcaPage.screenshot({ path: testInfo.outputPath('actions-selected-after.png') })
    await orcaPage.evaluate(() => window.__store?.getState().closeSettingsPage())
    await waitForActiveTerminalManager(orcaPage)
    await target.click()
    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toBeVisible()
    await expect(orcaPage.locator('[data-terminal-link-destination]')).toHaveText(LINK)
    await expectOrcaOwnedMouseOutcome(mouseLogPath)
    await orcaPage.screenshot({ path: testInfo.outputPath('actions-after.png') })
    await sendToTerminal(orcaPage, ptyId, 'q')
  })

  test('explicit Open URL and Leave to terminal choices preserve direct-open modifiers', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(orcaPage, testInfo)
    await startPanelNavigationObserver(electronApp, orcaPage.url())
    await openLegacyDisabledLinkSettings(orcaPage)
    const choices = orcaPage.getByRole('radiogroup', { name: 'Plain click URL behavior' })
    await choices.getByRole('radio', { name: 'Open URL', exact: true }).click()
    await expect(choices.getByRole('radio', { name: 'Open URL', exact: true })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await orcaPage.evaluate(() => window.__store?.getState().closeSettingsPage())
    await target.click()
    await expect
      .poll(async () => (await readPanelNavigationObserver(electronApp)).externalUrls)
      .toEqual([LINK])
    await expectOrcaOwnedMouseOutcome(mouseLogPath)

    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsPage()
      state?.openSettingsTarget({ pane: 'browser', repoId: null })
    })
    await choices.getByRole('radio', { name: 'Leave to terminal', exact: true }).click()
    await expect(
      choices.getByRole('radio', { name: 'Leave to terminal', exact: true })
    ).toHaveAttribute('aria-checked', 'true')
    await orcaPage.evaluate(() => window.__store?.getState().closeSettingsPage())
    await target.click()
    await expectChildMouseReports(mouseLogPath)
    expect((await readPanelNavigationObserver(electronApp)).externalUrls).toEqual([LINK])

    const reportsBeforeModifiedClick = childMouseReportCount(mouseLogPath)
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await orcaPage.keyboard.down(modifier)
    await target.click()
    await orcaPage.keyboard.up(modifier)
    await expect
      .poll(async () => (await readPanelNavigationObserver(electronApp)).externalUrls)
      .toEqual([LINK, LINK])
    await expectOrcaOwnedMouseOutcome(mouseLogPath, reportsBeforeModifiedClick)
    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toHaveCount(0)
    await sendToTerminal(orcaPage, ptyId, 'q')
  })

  test('an Orca-owned plain link click emits no child PTY mouse frames', async ({
    orcaPage
  }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(orcaPage, testInfo)
    await target.click()

    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toBeVisible()
    await expect(orcaPage.locator('[data-terminal-link-destination]')).toHaveText(LINK)

    await expectOrcaOwnedMouseOutcome(mouseLogPath)

    await sendToTerminal(orcaPage, ptyId, 'q')
  })

  test('an Orca-owned OSC link click emits no child PTY mouse frames', async ({
    orcaPage
  }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(
      orcaPage,
      testInfo,
      'osc'
    )
    await target.hover()
    await expect(orcaPage.locator('.xterm-hover')).toHaveCount(1)
    await target.click()

    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toBeVisible()
    await expect(orcaPage.locator('[data-terminal-link-destination]')).toHaveText(LINK)
    await expectOrcaOwnedMouseOutcome(mouseLogPath)

    await sendToTerminal(orcaPage, ptyId, 'q')
  })

  test('a plain click stays child-owned when link actions are disabled', async ({
    orcaPage
  }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(orcaPage, testInfo)
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ terminalLinkActionPopoverEnabled: false })
    })

    await target.click()

    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toHaveCount(0)
    await expectChildMouseReports(mouseLogPath)
    await sendToTerminal(orcaPage, ptyId, 'q')
  })

  test('a drag across a link stays child-owned', async ({ orcaPage }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(orcaPage, testInfo)

    const control = orcaPage
      .locator('.xterm:visible .xterm-rows > div')
      .filter({ hasText: 'CHILD_CONTROL' })
      .locator('span')
      .first()
    await expect(control).toBeVisible()
    await target.dragTo(control)

    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toHaveCount(0)
    await expectChildMouseReports(mouseLogPath)
    await sendToTerminal(orcaPage, ptyId, 'q')
  })
})

for (const mode of ['http', 'osc'] as const) {
  test(`real dashboard preview ${mode} composes exclusive actions with reporting-child refusal controls`, async ({
    orcaPage
  }, testInfo) => {
    const rawInputLog = testInfo.outputPath('child-all-input.log')
    const { mouseLogPath, ptyId } = await startMouseAwareLinkFixture(
      orcaPage,
      testInfo,
      mode,
      rawInputLog
    )
    await orcaPage.evaluate(async (id) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId = worktreeId ? state?.activeTabIdByWorktree[worktreeId] : null
      const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
      if (!state || !worktreeId || !tabId || !pane || !id) {
        throw new Error('missing actual source pane')
      }
      await state.updateSettings({
        experimentalAgentDashboardPopout: true,
        experimentalAgentDashboardMode: 'in-window',
        terminalLinkClickBehavior: 'actions',
        terminalRightClickToPaste: false,
        terminalGpuAcceleration: 'off'
      })
      // Display-only discovery for the real reporting child; this is not agent validation.
      state.setAgentStatus(
        `${tabId}:${pane.leafId}`,
        { state: 'working', prompt: 'Ownership fixture', agentType: 'codex' },
        'Codex',
        { updatedAt: Date.now(), stateStartedAt: Date.now() },
        { tabId, terminalHandle: id, worktreeId }
      )
    }, ptyId)
    await orcaPage.getByRole('button', { name: /Agent Dashboard/ }).click()
    await orcaPage.getByText('Ownership fixture', { exact: true }).first().click()
    const preview = orcaPage.locator('[data-agent-terminal-preview]')
    await expect(preview).toBeVisible()
    const label = mode === 'osc' ? OSC_LINK_TEXT : LINK
    const link = preview
      .locator('.xterm-rows > div')
      .filter({ hasText: label })
      .locator('span')
      .filter({ hasText: label })
      .first()
    const menu = orcaPage.locator('[data-terminal-link-action-popover]')
    await link.hover()
    const before = childMouseReportCount(mouseLogPath)
    await link.click()
    await expect(menu).toBeVisible()
    await expect(orcaPage.locator('[data-terminal-link-destination]')).toHaveText(LINK)
    await expectOrcaOwnedMouseOutcome(mouseLogPath, before)
    await orcaPage.keyboard.press('Escape')

    // Preview middle belongs to the child even when plain actions are enabled.
    await link.click({ button: 'middle' })
    await expect(menu).toHaveCount(0)
    await expect.poll(() => childMouseReportCount(mouseLogPath)).toBeGreaterThan(before)
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ terminalLinkClickBehavior: 'none' })
    })
    const beforeNone = childMouseReportCount(mouseLogPath)
    await link.click()
    await expect(menu).toHaveCount(0)
    await expect.poll(() => childMouseReportCount(mouseLogPath)).toBeGreaterThan(beforeNone)

    const control = preview
      .locator('.xterm-rows > div')
      .filter({ hasText: 'CHILD_CONTROL' })
      .locator('span')
      .first()
    const beforeControl = childMouseReportCount(mouseLogPath)
    await control.click()
    await expect.poll(() => childMouseReportCount(mouseLogPath)).toBeGreaterThan(beforeControl)
    if (process.platform === 'darwin') {
      await orcaPage.evaluate(async () => {
        await window.__store?.getState().updateSettings({ terminalLinkClickBehavior: 'actions' })
      })
      await link.hover()
      const beforeNative = childMouseReportCount(mouseLogPath)
      await link.click({ modifiers: ['Control', 'Alt'] })
      await expect(menu).toBeVisible()
      await expectOrcaOwnedMouseOutcome(mouseLogPath, beforeNative)
      await orcaPage.keyboard.press('Escape')
      await control.click()
      const rawBefore = existsSync(rawInputLog) ? readFileSync(rawInputLog, 'utf8').length : 0
      await preview.locator('.xterm-helper-textarea').press('Control+Alt+ArrowUp')
      await expect
        .poll(() => (existsSync(rawInputLog) ? readFileSync(rawInputLog, 'utf8').length : 0))
        .toBeGreaterThan(rawBefore)
      await expect(menu).toHaveCount(0)
    }
    if (process.platform === 'win32') {
      await preview.locator('.xterm-helper-textarea').press('Shift+F10')
      await expect
        .poll(() =>
          existsSync(rawInputLog) ? readFileSync(rawInputLog, 'utf8').replace(/\s/g, '') : ''
        )
        .toContain('1b5b32313b327e')
    }
    await sendToTerminal(orcaPage, ptyId, 'q')
  })
}
