import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { resolveCliCommand } from '../../src/shared/node-cli-command-resolution'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.skip(
  process.env.ORCA_REAL_ANNOTATION_TEST !== '1',
  'Set ORCA_REAL_ANNOTATION_TEST=1 with an authenticated agent CLI to run the live demo'
)

test('real agent understands a persistent annotation on its greeting', async ({
  orcaPage: page,
  electronApp
}, testInfo) => {
  test.setTimeout(240_000)
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  const agent = process.env.ORCA_REAL_ANNOTATION_AGENT === 'codex' ? 'codex' : 'claude'
  const sourceHome = process.env.ORCA_REAL_ANNOTATION_CODEX_HOME
  if (agent === 'codex' && sourceHome) {
    const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
    const target = join(home, '.codex')
    mkdirSync(target, { recursive: true, mode: 0o700 })
    const source = parse(readFileSync(join(sourceHome, 'config.toml'), 'utf8'))
    const config = Object.fromEntries(
      Object.entries(source).filter(([key]) =>
        ['model', 'model_provider', 'model_providers', 'model_reasoning_effort'].includes(key)
      )
    )
    writeFileSync(join(target, 'config.toml'), stringify(config), { mode: 0o600 })
    copyFileSync(join(sourceHome, 'auth.json'), join(target, 'auth.json'))
  }
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.setSize(1280, 900)
    }
  })
  await page.evaluate(
    async ({ agent, command }) => {
      await window.__store?.getState().updateSettings({
        experimentalNativeChat: true,
        uiLanguage: 'en',
        theme: 'dark',
        agentCmdOverrides: { [agent]: command }
      })
    },
    { agent, command: process.env.ORCA_REAL_ANNOTATION_COMMAND || resolveCliCommand(agent) }
  )
  await page.getByRole('button', { name: 'New tab', exact: true }).click()
  await page
    .getByRole('menuitem', {
      name: `Start a chat with ${agent === 'codex' ? 'Codex' : 'Claude'}`,
      exact: true
    })
    .click()
  const root = page.locator('[data-native-chat-root="true"]')
  const composer = root.getByRole('textbox')
  await expect(composer).toBeEditable({ timeout: 60_000 })
  await composer.fill('hi')
  await composer.press('Enter')
  const replies = root.locator('[data-native-chat-quote-source]')
  await expect(replies.first()).toBeVisible({ timeout: 90_000 })
  await expect(root.getByRole('button', { name: 'Send', exact: true })).toBeVisible({
    timeout: 90_000
  })
  const greeting = await replies.first().innerText()
  expect(greeting.trim().length).toBeGreaterThan(2)
  const later = page.getByRole('button', { name: 'Later', exact: true })
  if (await later.isVisible()) {
    await later.click()
  }
  await page.screenshot({ path: testInfo.outputPath('01-real-greeting.png') })
  await replies.first().click({ clickCount: 3 })
  const selectedQuote = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(selectedQuote.trim().length).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Add annotation', exact: true }).click()
  const editor = root.getByRole('dialog', { name: 'Comment', exact: true })
  const comment =
    'This comment is attached to the selected words in your greeting. Explain what those words mean in context, then give one concrete example of a coding task I could ask you to do. Start your answer with "Annotation understood:".'
  await editor.getByRole('textbox', { name: 'Comment', exact: true }).fill(comment)
  await expect.poll(() => editor.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  await page.screenshot({ path: testInfo.outputPath('02-annotate-greeting.png') })
  await editor.getByRole('button', { name: 'Save annotation', exact: true }).click()
  await expect(root.getByRole('button', { name: '1 annotation', exact: true })).toBeVisible()
  await page.reload()
  await waitForSessionReady(page)
  await expect(root.getByRole('button', { name: '1 annotation', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await root.getByRole('button', { name: '1 annotation', exact: true }).click()
  const tray = root.getByRole('region', { name: 'Annotations', exact: true })
  await expect(tray).toContainText(comment)
  await expect.poll(() => tray.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  await page.screenshot({ path: testInfo.outputPath('03-restored-annotation.png') })
  await root.getByRole('button', { name: '1 annotation', exact: true }).click()
  await expect(composer).toBeEmpty()
  await composer.press('Enter')
  await expect(root.getByRole('button', { name: '1 annotation', exact: true })).toHaveCount(0)
  const answer = replies.filter({ hasText: 'Annotation understood:' }).last()
  await expect(answer).toBeVisible({ timeout: 90_000 })
  await expect(root.getByRole('button', { name: 'Send', exact: true })).toBeVisible({
    timeout: 90_000
  })
  let previousResponse = ''
  let stableSince = 0
  await expect
    .poll(
      async () => {
        const current = await answer.innerText()
        if (current !== previousResponse) {
          previousResponse = current
          stableSince = Date.now()
        }
        return (
          current.length > 80 && /[.!?]["”]?\s*$/.test(current) && Date.now() - stableSince >= 3000
        )
      },
      { timeout: 90_000, intervals: [500] }
    )
    .toBe(true)
  const response = await answer.innerText()
  expect(response.length).toBeGreaterThan(80)
  await page.screenshot({ path: testInfo.outputPath('04-agent-understands-annotation.png') })
  const hidden = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((window) => !window.isVisible())
  )
  expect(hidden).toBe(true)
  writeFileSync(
    testInfo.outputPath('real-agent-receipt.json'),
    JSON.stringify(
      { agent, initialMessage: 'hi', greeting, selectedQuote, comment, response, hidden },
      null,
      2
    )
  )
})
