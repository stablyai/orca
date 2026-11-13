import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from './helpers/orca-app'
import { SUPPORTED, openStubChat, test } from './helpers/structured-claude-stub'

test('New divider survives arrival and Find, then clears after reading @divider', async ({
  electronApp,
  orcaPage: page,
  claudeStub
}, testInfo) => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')
  await page.setViewportSize({ width: 1280, height: 900 })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const gate = path.join(path.dirname(claudeStub.command), 'release-reply')
  const producer = path.join(process.cwd(), 'tests/e2e/fixtures/structured-claude-stub.cjs')
  const localProducer = path.join(path.dirname(claudeStub.command), 'divider-stub.cjs')
  const reply = Array.from(
    { length: 80 },
    (_, i) => `Reading paragraph ${i}. This long reply exercises actual transcript geometry.`
  ).join('\n\n')
  writeFileSync(
    localProducer,
    readFileSync(producer, 'utf8')
      .replace("text: 'Stub reply.'", `text: ${JSON.stringify(reply)}`)
      .replace('turnTimer = setTimeout(', 'turnTimer = setInterval(')
      .replace(
        '      })\n    },',
        `      })\n      fs.writeFileSync(${JSON.stringify(`${gate}.done`)}, 'reply written')\n    },`
      )
      .replace(
        '      turnTimer = null',
        `      if (!fs.existsSync(${JSON.stringify(gate)})) return\n      clearInterval(turnTimer)\n      turnTimer = null`
      )
  )
  writeFileSync(
    claudeStub.command,
    readFileSync(claudeStub.command, 'utf8').replace(producer, localProducer)
  )

  const { tab, composer, send, stop } = await openStubChat(page, claudeStub.command)
  await page.evaluate(async () => {
    await window.__store?.getState().updateSettings({ nativeChatMarkNewMessages: true })
  })
  const awayTab = await page.evaluate(() => {
    const state = window.__store!.getState()
    return state.tabsByWorktree[state.activeWorktreeId!][0].id
  })
  const leaveChat = () =>
    page.evaluate((tabId) => {
      const state = window.__store!.getState()
      state.setActiveTab(tabId)
      state.setActiveTabType('terminal', state.activeWorktreeId)
    }, awayTab)
  await composer.fill('Read this reply after returning to the chat.')
  await send.click()
  await expect(stop).toBeVisible({ timeout: 30_000 })
  await expect(composer).toHaveText('')

  await leaveChat()
  await expect(composer).not.toBeVisible()
  writeFileSync(gate, 'reply may arrive while the reader is away')
  await expect.poll(() => existsSync(`${gate}.done`)).toBe(true)
  await tab.click()
  await expect(composer).toBeVisible()
  const lastParagraph = page.getByText('Reading paragraph 79.', { exact: false })
  await expect(lastParagraph).toHaveCount(1, { timeout: 30_000 })
  await expect(stop).toHaveCount(0, { timeout: 30_000 })
  const marker = page.locator('[data-native-chat-new-rows-marker]')
  const scroller = page.locator('[data-native-chat-scroll]').filter({ visible: true })
  await expect(marker).toHaveCount(1)
  await expect
    .poll(() =>
      marker.evaluate((element) => {
        const scroll = element.closest('[data-native-chat-scroll]')!
        const line = element.getBoundingClientRect()
        const viewport = scroll.getBoundingClientRect()
        return line.bottom > viewport.top && line.top < viewport.bottom
      })
    )
    .toBe(true)
  await page.screenshot({ path: testInfo.outputPath('divider-arrival.png') })

  await page.keyboard.press('ControlOrMeta+f')
  const find = page.getByRole('textbox', { name: 'Find in chat' })
  await find.fill('Reading paragraph 79.')
  await find.press('Enter')
  await expect
    .poll(() =>
      lastParagraph.evaluate((element) => {
        const scroll = element.closest('[data-native-chat-scroll]')!
        const row = element.getBoundingClientRect()
        const viewport = scroll.getBoundingClientRect()
        return row.top >= viewport.top && row.bottom <= viewport.bottom
      })
    )
    .toBe(true)
  await expect(marker).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath('divider-find.png') })
  await find.press('Escape')

  const viewport = await scroller.boundingBox()
  if (!viewport) {
    throw new Error('Transcript has no rendered viewport')
  }
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
  await page.mouse.wheel(0, -20000)
  await expect
    .poll(() => marker.evaluate((element) => element.getBoundingClientRect().top))
    .toBeGreaterThanOrEqual(viewport.y)
  await page.mouse.wheel(0, 700)
  await expect(marker).toHaveCount(0)

  await leaveChat()
  await expect(composer).not.toBeVisible()
  await tab.click()
  await expect(composer).toBeVisible()
  await expect(marker).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('divider-read-return.png') })
  expect(
    await electronApp.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length
    )
  ).toBe(0)
})
