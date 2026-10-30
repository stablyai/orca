import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import type { Terminal } from '@xterm/xterm'
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
const CONTROL_TEXT = 'CHILD_CONTROL Press q to exit'

type LinkMode = 'http' | 'osc'
type FixtureSource = {
  ptyId: string
  worktreeId: string
  worktreeName: string
  tabId: string
  leafId: string
  mode: LinkMode
}

async function checkedTerminalLabel(
  page: Page,
  source: FixtureSource,
  text: string,
  preview = false,
  hovered = false
): Promise<Locator> {
  const scope = preview
    ? page.locator('[data-agent-terminal-preview]:visible')
    : page.locator(
        `.pane[data-leaf-id=${JSON.stringify(source.leafId)}][data-pty-id=${JSON.stringify(source.ptyId)}]`
      )
  const target = scope
    .locator('.xterm:visible .xterm-rows > div')
    .filter({ hasText: text })
    .locator('span')
    .filter({ hasText: text })
    .first()
  await expect(target).toBeVisible()
  await target.evaluate(
    (label, args) => {
      function isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === 'object'
      }
      function read(value: unknown, key: string): unknown {
        return isRecord(value) ? value[key] : undefined
      }
      const state = window.__store?.getState()
      const manager = window.__paneManagers?.get(args.source.tabId)
      const pane = manager?.getPanes().find((item) => item.leafId === args.source.leafId)
      if (
        !state ||
        state.activeWorktreeId !== args.source.worktreeId ||
        state.activeTabIdByWorktree[args.source.worktreeId] !== args.source.tabId ||
        manager?.getActivePane()?.leafId !== args.source.leafId ||
        pane?.container.dataset.ptyId !== args.source.ptyId ||
        state.terminalLayoutsByTabId[args.source.tabId]?.ptyIdsByLeafId?.[args.source.leafId] !==
          args.source.ptyId ||
        !state.ptyIdsByTabId[args.source.tabId]?.includes(args.source.ptyId)
      ) {
        throw new Error('Expected live worktree/pane/PTY source changed')
      }
      const element = label.closest('.xterm')
      let terminal: Terminal | null = null
      if (args.preview) {
        const container = label.closest('[data-agent-terminal-preview]')
        // Read the actual component refs; never publish state or invoke preview callbacks.
        let fiber: unknown =
          container &&
          Object.entries(container).find(([key]) => key.startsWith('__reactFiber$'))?.[1]
        while (fiber) {
          const props = read(fiber, 'memoizedProps')
          const linkSource = read(props, 'linkSource')
          if (
            read(props, 'ptyId') === args.source.ptyId &&
            read(linkSource, 'worktreeId') === args.source.worktreeId &&
            read(linkSource, 'tabId') === args.source.tabId &&
            read(linkSource, 'leafId') === args.source.leafId &&
            read(linkSource, 'ptyId') === args.source.ptyId
          ) {
            let hook = read(fiber, 'memoizedState')
            while (hook) {
              const current = read(read(hook, 'memoizedState'), 'current')
              if (read(current, 'element') === element && read(current, 'buffer')) {
                // SAFETY: this is the mounted component's terminal ref, matched to its actual xterm element and source props.
                terminal = current as Terminal
                break
              }
              hook = read(hook, 'next')
            }
            break
          }
          fiber = read(fiber, 'return')
        }
      } else {
        terminal = pane?.terminal ?? null
      }
      const screen = element?.querySelector('.xterm-screen')
      if (
        !terminal ||
        !screen ||
        terminal.element !== element ||
        !label.isConnected ||
        !element?.isConnected ||
        !element.contains(label) ||
        terminal.modes.mouseTrackingMode === 'none' ||
        terminal.buffer.active.type !== 'alternate' ||
        read(read(read(terminal, '_core'), 'mouseStateService'), 'activeEncoding') !== 'SGR'
      ) {
        throw new Error('Intended connected reporting terminal unavailable')
      }
      const labelRect = label.getBoundingClientRect()
      const rect = screen.getBoundingClientRect()
      const centerX = labelRect.left + labelRect.width / 2
      const centerY = labelRect.top + labelRect.height / 2
      const hit = document.elementFromPoint(centerX, centerY)
      if (
        labelRect.width <= 0 ||
        labelRect.height <= 0 ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        centerX < 0 ||
        centerY < 0 ||
        centerX >= innerWidth ||
        centerY >= innerHeight ||
        centerX < rect.left ||
        centerX >= rect.right ||
        centerY < rect.top ||
        centerY >= rect.bottom ||
        !hit ||
        !screen.contains(hit)
      ) {
        throw new Error('Semantic label center does not hit its own current xterm screen')
      }
      const column = Math.floor((centerX - rect.left) / (rect.width / terminal.cols))
      const row = Math.floor((centerY - rect.top) / (rect.height / terminal.rows))
      const bufferRow = terminal.buffer.active.viewportY + row
      const line = terminal.buffer.active.getLine(bufferRow)
      const start = line?.translateToString(false).indexOf(args.text) ?? -1
      if (
        row < 0 ||
        row >= terminal.rows ||
        start < 0 ||
        column < start ||
        column >= start + args.text.length
      ) {
        throw new Error('Semantic label center is outside the actual buffer text range')
      }
      if (args.text !== args.control && args.source.mode === 'osc') {
        const cell = line?.getCell(column)
        const id = read(read(cell, 'extended'), 'urlId')
        const service = read(read(terminal, '_core'), '_oscLinkService')
        const getLinkData = read(service, 'getLinkData')
        if (
          typeof id !== 'number' ||
          id <= 0 ||
          typeof getLinkData !== 'function' ||
          read(getLinkData.call(service, id), 'uri') !== args.destination
        ) {
          throw new Error('Actual OSC cell destination differs from the fixture URL')
        }
      }
      if (args.hovered) {
        const link = read(read(read(read(terminal, '_core'), 'linkifier'), '_currentLink'), 'link')
        const range = read(link, 'range')
        const first = read(range, 'start')
        const last = read(range, 'end')
        const sx = read(first, 'x'),
          sy = read(first, 'y')
        const ex = read(last, 'x'),
          ey = read(last, 'y')
        const valid = read(link, 'isBufferValid')
        const cell = (bufferRow + 1) * terminal.cols + column + 1
        if (
          read(link, 'text') !== args.destination ||
          typeof sx !== 'number' ||
          typeof sy !== 'number' ||
          typeof ex !== 'number' ||
          typeof ey !== 'number' ||
          cell < sy * terminal.cols + sx ||
          cell > ey * terminal.cols + ex ||
          (typeof valid === 'function' && !valid.call(link))
        ) {
          throw new Error('Real hover has not established the current typed link/range')
        }
      }
    },
    { source, text, preview, hovered, destination: LINK, control: CONTROL_TEXT }
  )
  return target
}

async function hoverFixtureLink(
  page: Page,
  source: FixtureSource,
  preview = false
): Promise<Locator> {
  const text = source.mode === 'osc' ? OSC_LINK_TEXT : LINK
  // Only bypass the DOM span's own screen interception after current source/cell/hit-test checks.
  await (await checkedTerminalLabel(page, source, text, preview)).hover({ force: true })
  await expect(async () => {
    await checkedTerminalLabel(page, source, text, preview, true)
  }).toPass({ timeout: 5_000 })
  return checkedTerminalLabel(page, source, text, preview, true)
}

async function clickFixtureLink(
  page: Page,
  source: FixtureSource,
  preview = false,
  options: Parameters<Locator['click']>[0] = {}
): Promise<void> {
  const target = await hoverFixtureLink(page, source, preview)
  await target.click({ ...options, force: true })
}

async function startMouseAwareLinkFixture(
  orcaPage: Page,
  testInfo: TestInfo,
  linkMode: LinkMode = 'http',
  inputLogPath?: string
): Promise<{ mouseLogPath: string; ptyId: string; source: FixtureSource }> {
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
  await waitForTerminalOutput(orcaPage, 'LINK_MOUSE_READY')
  const source = await orcaPage.evaluate(
    ({ ptyId, mode }) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId = worktreeId ? state?.activeTabIdByWorktree[worktreeId] : null
      const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
      const worktreeName = worktreeId
        ? Object.values(state?.worktreesByRepo ?? {})
            .flat()
            .find((item) => item.id === worktreeId)?.displayName
        : null
      if (
        !worktreeId ||
        !tabId ||
        !pane ||
        !worktreeName ||
        pane.container.dataset.ptyId !== ptyId
      ) {
        throw new Error('Missing real fixture source identity')
      }
      return { ptyId, worktreeId, worktreeName, tabId, leafId: pane.leafId, mode }
    },
    { ptyId, mode: linkMode }
  )
  await checkedTerminalLabel(orcaPage, source, linkMode === 'osc' ? OSC_LINK_TEXT : LINK)
  return { mouseLogPath, ptyId, source }
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
    const { mouseLogPath, ptyId, source } = await startMouseAwareLinkFixture(orcaPage, testInfo)
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
    await clickFixtureLink(orcaPage, source)
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
    const { mouseLogPath, ptyId, source } = await startMouseAwareLinkFixture(orcaPage, testInfo)
    await startPanelNavigationObserver(electronApp, orcaPage.url())
    await openLegacyDisabledLinkSettings(orcaPage)
    const choices = orcaPage.getByRole('radiogroup', { name: 'Plain click URL behavior' })
    await choices.getByRole('radio', { name: 'Open URL', exact: true }).click()
    await expect(choices.getByRole('radio', { name: 'Open URL', exact: true })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await orcaPage.evaluate(() => window.__store?.getState().closeSettingsPage())
    await clickFixtureLink(orcaPage, source)
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
    await clickFixtureLink(orcaPage, source)
    await expectChildMouseReports(mouseLogPath)
    expect((await readPanelNavigationObserver(electronApp)).externalUrls).toEqual([LINK])

    const reportsBeforeModifiedClick = childMouseReportCount(mouseLogPath)
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await orcaPage.keyboard.down(modifier)
    await clickFixtureLink(orcaPage, source)
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
    const { mouseLogPath, ptyId, source } = await startMouseAwareLinkFixture(orcaPage, testInfo)
    await clickFixtureLink(orcaPage, source)

    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toBeVisible()
    await expect(orcaPage.locator('[data-terminal-link-destination]')).toHaveText(LINK)

    await expectOrcaOwnedMouseOutcome(mouseLogPath)

    await sendToTerminal(orcaPage, ptyId, 'q')
  })

  test('an Orca-owned OSC link click emits no child PTY mouse frames', async ({
    orcaPage
  }, testInfo) => {
    const { mouseLogPath, ptyId, source } = await startMouseAwareLinkFixture(
      orcaPage,
      testInfo,
      'osc'
    )
    await hoverFixtureLink(orcaPage, source)
    await expect(orcaPage.locator('.xterm-hover')).toHaveCount(1)
    await clickFixtureLink(orcaPage, source)

    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toBeVisible()
    await expect(orcaPage.locator('[data-terminal-link-destination]')).toHaveText(LINK)
    await expectOrcaOwnedMouseOutcome(mouseLogPath)

    await sendToTerminal(orcaPage, ptyId, 'q')
  })

  test('a plain click stays child-owned when link actions are disabled', async ({
    orcaPage
  }, testInfo) => {
    const { mouseLogPath, ptyId, source } = await startMouseAwareLinkFixture(orcaPage, testInfo)
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ terminalLinkActionPopoverEnabled: false })
    })

    await clickFixtureLink(orcaPage, source)

    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toHaveCount(0)
    await expectChildMouseReports(mouseLogPath)
    await sendToTerminal(orcaPage, ptyId, 'q')
  })

  test('a drag across a link stays child-owned', async ({ orcaPage }, testInfo) => {
    const { mouseLogPath, ptyId, source } = await startMouseAwareLinkFixture(orcaPage, testInfo)

    const target = await hoverFixtureLink(orcaPage, source)
    const control = await checkedTerminalLabel(orcaPage, source, CONTROL_TEXT)
    await target.dragTo(control, { force: true })

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
    const { mouseLogPath, ptyId, source } = await startMouseAwareLinkFixture(
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
    const board = orcaPage.locator('[data-agent-dashboard-sheet]:visible')
    await expect(board).toBeVisible()
    const card = board
      .getByRole('button')
      .filter({ hasText: 'Ownership fixture' })
      .filter({
        has: orcaPage.getByText(source.worktreeName, { exact: true })
      })
    await expect(card).toHaveCount(1)
    await expect(card).toBeVisible()
    await expect
      .poll(() =>
        orcaPage.evaluate((expected) => {
          const state = window.__store?.getState()
          const pane = window.__paneManagers
            ?.get(expected.tabId)
            ?.getPanes()
            .find((item) => item.leafId === expected.leafId)
          return (
            pane?.container.dataset.ptyId === expected.ptyId &&
            state?.terminalLayoutsByTabId[expected.tabId]?.ptyIdsByLeafId?.[expected.leafId] ===
              expected.ptyId &&
            state?.ptyIdsByTabId[expected.tabId]?.includes(expected.ptyId) === true
          )
        }, source)
      )
      .toBe(true)
    await card.click()
    const preview = orcaPage.locator('[data-agent-terminal-preview]')
    await expect(preview).toBeVisible()
    const menu = orcaPage.locator('[data-terminal-link-action-popover]')
    await hoverFixtureLink(orcaPage, source, true)
    const before = childMouseReportCount(mouseLogPath)
    await clickFixtureLink(orcaPage, source, true)
    await expect(menu).toBeVisible()
    await expect(orcaPage.locator('[data-terminal-link-destination]')).toHaveText(LINK)
    await expectOrcaOwnedMouseOutcome(mouseLogPath, before)
    await orcaPage.keyboard.press('Escape')

    // Preview middle belongs to the child even when plain actions are enabled.
    await clickFixtureLink(orcaPage, source, true, { button: 'middle' })
    await expect(menu).toHaveCount(0)
    await expect.poll(() => childMouseReportCount(mouseLogPath)).toBeGreaterThan(before)
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ terminalLinkClickBehavior: 'none' })
    })
    const beforeNone = childMouseReportCount(mouseLogPath)
    await clickFixtureLink(orcaPage, source, true)
    await expect(menu).toHaveCount(0)
    await expect.poll(() => childMouseReportCount(mouseLogPath)).toBeGreaterThan(beforeNone)

    const beforeControl = childMouseReportCount(mouseLogPath)
    await (await checkedTerminalLabel(orcaPage, source, CONTROL_TEXT, true)).click({ force: true })
    await expect.poll(() => childMouseReportCount(mouseLogPath)).toBeGreaterThan(beforeControl)
    if (process.platform === 'darwin') {
      await orcaPage.evaluate(async () => {
        await window.__store?.getState().updateSettings({ terminalLinkClickBehavior: 'actions' })
      })
      await hoverFixtureLink(orcaPage, source, true)
      const beforeNative = childMouseReportCount(mouseLogPath)
      await clickFixtureLink(orcaPage, source, true, { modifiers: ['Control', 'Alt'] })
      await expect(menu).toBeVisible()
      await expectOrcaOwnedMouseOutcome(mouseLogPath, beforeNative)
      await orcaPage.keyboard.press('Escape')
      await (
        await checkedTerminalLabel(orcaPage, source, CONTROL_TEXT, true)
      ).click({ force: true })
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
