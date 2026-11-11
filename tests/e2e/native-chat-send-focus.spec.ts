// Completed tab and composer actions return keyboard input to the chat draft.

import type { Locator } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { SUPPORTED, openStubChat, test } from './helpers/structured-claude-stub'

function focusIsIn(composer: Locator): Promise<boolean> {
  return composer.evaluate((element) => element.contains(element.ownerDocument.activeElement))
}

test.describe('native chat composer focus', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('quick launcher keeps focus when Copy Context completes', async ({
    electronApp,
    orcaPage: page,
    claudeStub
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const { composer, send, reply } = await openStubChat(page, claudeStub.command)
    await page.keyboard.type('hello')
    await send.click()
    await expect(reply).toBeVisible({ timeout: 30_000 })
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('clipboard:writeTerminalText')
      ipcMain.handle(
        'clipboard:writeTerminalText',
        () =>
          new Promise<void>((resolve) => {
            const gate: { pid: number; releaseContextCopy?: () => void } = process
            gate.releaseContextCopy = resolve
          })
      )
    })
    await reply.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy Context', exact: true }).click()
    await expect
      .poll(() =>
        electronApp.evaluate(() => {
          const gate: { pid: number; releaseContextCopy?: () => void } = process
          return typeof gate.releaseContextCopy === 'function'
        })
      )
      .toBe(true)
    await page.getByRole('button', { name: 'New tab', exact: true }).click()
    const menu = page.getByRole('menu', { name: 'New tab', exact: true })
    const search = menu.getByRole('combobox')
    await expect(search).toBeFocused()

    await electronApp.evaluate(() => {
      const gate: { pid: number; releaseContextCopy?: () => void } = process
      gate.releaseContextCopy?.()
    })

    await expect(page.getByText('Context copied', { exact: true })).toBeVisible()
    await expect(menu).toBeVisible()
    await expect(search).toBeFocused()
    await page.keyboard.type('terminal')
    await expect(search).toHaveValue('terminal')
    await expect(composer).toHaveText('')
    await page.screenshot({ path: testInfo.outputPath('quick-launch-focus.png') })
  })

  test('keyboard tab rename returns input to the native chat composer', async ({
    orcaPage: page,
    claudeStub
  }) => {
    const { tab, composer } = await openStubChat(page, claudeStub.command)
    await tab.dblclick()
    const rename = tab.locator('[data-tab-rename-input="true"]')
    await expect(rename).toBeFocused()
    await rename.fill('')
    await rename.pressSequentially('Renamed chat', { delay: 60 })
    await page.keyboard.press('Enter')
    await expect(rename).toHaveCount(0)
    await expect(tab).toHaveAttribute('data-tab-title', 'Renamed chat')
    await expect.poll(() => focusIsIn(composer)).toBe(true)
    await page.keyboard.type('Draft after rename')
    await expect(composer).toContainText('Draft after rename')
  })

  test('when Send disables at the end of the turn', async ({ orcaPage: page, claudeStub }) => {
    const { composer, send, stop, reply } = await openStubChat(page, claudeStub.command)
    await page.keyboard.type('hello')
    await send.click()
    await expect(reply).toBeVisible({ timeout: 30_000 })
    await expect(stop).toHaveCount(0)
    await expect.poll(() => focusIsIn(composer)).toBe(true)
  })

  test('when Stop disables while the stop is in flight', async ({ orcaPage: page, claudeStub }) => {
    const { composer, send, stop } = await openStubChat(page, claudeStub.command)
    // The stub runs a prompt containing "slow" until it is interrupted.
    await page.keyboard.type('slow')
    await send.click()
    await stop.click()
    await expect(stop).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => focusIsIn(composer)).toBe(true)
  })
})
