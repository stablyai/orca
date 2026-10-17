import type { Page, TestInfo } from '@stablyai/playwright-test'
import { writeFile } from 'node:fs/promises'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForTerminalOutput } from './helpers/terminal'

async function prepare(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await ensureTerminalVisible(page)
  await page.setViewportSize({ width: 1920, height: 1000 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Renderer store unavailable')
    }
    const settings = store.getState().settings
    if (!settings) {
      throw new Error('Settings have not loaded')
    }
    store.setState({
      sidebarOpen: true,
      rightSidebarOpen: false,
      settings: {
        ...settings,
        uiLanguage: 'en',
        experimentalAgentDashboardPopout: true,
        experimentalAgentDashboardMode: 'in-window',
        experimentalAgentDashboardShowIdle: true
      }
    })
  })
}

async function openFromSidebar(page: Page): Promise<void> {
  const opener = page.locator('[data-contextual-tour-target="agents-sidebar"]')
  await opener.focus()
  await opener.press('Enter')
  await expect(page.locator('[data-agent-dashboard-sheet]')).toBeVisible()
  await expect(opener).toBeFocused()
  await page.getByRole('textbox', { name: 'Search agents' }).click()
}

async function recordFocus(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  const focusPath = testInfo.outputPath(`${label}-focus.json`)
  await writeFile(
    focusPath,
    JSON.stringify(
      await page.evaluate(() => ({
        activeTag: document.activeElement?.tagName,
        activeName: document.activeElement?.getAttribute('aria-label'),
        isSidebarOpener: document.activeElement?.matches(
          '[data-contextual-tour-target="agents-sidebar"]'
        ),
        isTerminalInput: document.activeElement?.matches('.xterm-helper-textarea')
      }))
    )
  )
  await testInfo.attach(`${label}-focus`, { contentType: 'application/json', path: focusPath })
  const opener = page.locator('[data-contextual-tour-target="agents-sidebar"]')
  // Evidence-only outline makes DOM focus visible without changing product styling.
  const outline = await page.addStyleTag({
    content:
      '[data-contextual-tour-target="agents-sidebar"]:focus { outline: 2px solid var(--ring); outline-offset: -2px; }'
  })
  await opener.screenshot({ path: testInfo.outputPath(`${label}.png`) })
  await outline.evaluate((element) => element.parentNode?.removeChild(element))
}

test('returns focus to the sidebar opener after Escape and Close', async ({
  orcaPage
}, testInfo) => {
  await prepare(orcaPage)
  const sheet = orcaPage.locator('[data-agent-dashboard-sheet]')
  const opener = orcaPage.locator('[data-contextual-tour-target="agents-sidebar"]')
  for (const dismiss of ['Escape', 'Close']) {
    await openFromSidebar(orcaPage)
    await orcaPage
      .getByRole('textbox', { name: 'Search agents' })
      .screenshot({ path: testInfo.outputPath(`${dismiss}-search.png`) })
    await (dismiss === 'Escape'
      ? orcaPage.keyboard.press('Escape')
      : orcaPage.getByRole('button', { name: 'Close dashboard', exact: true }).click())
    await expect(sheet).toHaveCount(0)
    try {
      await expect(opener).toBeFocused()
    } finally {
      await recordFocus(orcaPage, testInfo, dismiss)
    }
  }
})

test('keeps terminal focus and input after outside dismissal and agent reveal', async ({
  orcaPage
}, testInfo) => {
  await prepare(orcaPage)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const leafId = descriptor.paneKey.slice(descriptor.paneKey.indexOf(':') + 1)
  const pane = orcaPage
    .locator(`[data-leaf-id="${leafId}"]`)
    .filter({ has: orcaPage.locator('.xterm-helper-textarea') })
    .first()
  const input = pane.locator('.xterm-helper-textarea')
  const sheet = orcaPage.locator('[data-agent-dashboard-sheet]')

  await openFromSidebar(orcaPage)
  const bounds = await pane.boundingBox()
  const sheetBounds = await sheet.boundingBox()
  if (!bounds || !sheetBounds || bounds.x + bounds.width <= sheetBounds.x + sheetBounds.width) {
    throw new Error('Terminal must extend to the right of the drawer for outside dismissal')
  }
  await orcaPage.mouse.click(bounds.x + bounds.width - 40, bounds.y + 100)
  await expect(sheet).toHaveCount(0)
  await expect(input).toBeFocused()
  await orcaPage.keyboard.type('focus-test-outside')
  await waitForTerminalOutput(orcaPage, 'focus-test-outside')
  await orcaPage.keyboard.press('Control+u')
  await recordFocus(orcaPage, testInfo, 'outside')

  await orcaPage.evaluate(({ paneKey, worktreeId }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'Focus return fixture', agentType: 'codex' },
        'Codex',
        { updatedAt: Date.now(), stateStartedAt: Date.now() },
        { tabId: paneKey.slice(0, paneKey.indexOf(':')), worktreeId }
      )
  }, descriptor)
  await openFromSidebar(orcaPage)
  await sheet.getByRole('button').filter({ hasText: 'Focus return fixture' }).click()
  const reveal = orcaPage.getByRole('button', { name: 'Open worktree', exact: true })
  await expect(reveal).toBeVisible()
  await reveal.click()
  await expect(sheet).toHaveCount(0)
  await expect(input).toBeFocused()
  await orcaPage.keyboard.type('focus-test-reveal')
  await waitForTerminalOutput(orcaPage, 'focus-test-reveal')
  await orcaPage.keyboard.press('Control+u')
  await recordFocus(orcaPage, testInfo, 'reveal')
})

test('preserves nested Escape and recaptures focus on reopening during the exit animation', async ({
  orcaPage
}) => {
  await prepare(orcaPage)
  await openFromSidebar(orcaPage)
  const sheet = orcaPage.locator('[data-agent-dashboard-sheet]')
  await sheet.getByRole('button', { name: 'Filter', exact: true }).click()
  await expect(orcaPage.getByRole('menu')).toBeVisible()
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.getByRole('menu')).toHaveCount(0)
  await expect(sheet).toBeVisible()
  await sheet.getByRole('textbox', { name: 'Search agents' }).click()

  // Reopen on the actual exit animation, while Radix still retains this Content.
  await sheet.evaluate((content) => {
    const reopen = (): void => {
      if (content.getAttribute('data-state') !== 'closed') {
        return
      }
      content.removeEventListener('animationstart', reopen)
      const input = document.querySelector<HTMLElement>('[data-leaf-id] .xterm-helper-textarea')
      if (!input) {
        throw new Error('Terminal input unavailable')
      }
      input.focus()
      window.__store?.getState().setAgentDashboardDrawerOpen(true)
      requestAnimationFrame(() => {
        content.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')?.focus()
        content.setAttribute('data-focus-test-reopened', 'true')
      })
    }
    content.addEventListener('animationstart', reopen)
  })
  await orcaPage.keyboard.press('Escape')
  await expect(sheet).toHaveAttribute('data-focus-test-reopened', 'true')
  await expect(sheet).toHaveAttribute('data-state', 'open')
  await expect(sheet.getByRole('textbox', { name: 'Search agents' })).toBeFocused()
  await orcaPage.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(orcaPage.locator('[data-leaf-id] .xterm-helper-textarea')).toBeFocused()
})
