import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { expect } from './helpers/orca-app'
import { SUPPORTED, openStubChat, test } from './helpers/structured-claude-stub'

test('steers again before the previous echo and retains delivery across tab navigation', async ({
  orcaPage: page,
  claudeStub
}, testInfo) => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.evaluate(() =>
    window.__store!.getState().updateSettings({ uiLanguage: 'en', nativeChatQueueFollowUps: true })
  )
  const { tab, composer, send, stop } = await openStubChat(page, claudeStub.command)
  const chat = page.locator('[data-native-chat-root="true"]')
  const card = (text: string) => chat.locator('[data-queued-message-id]').filter({ hasText: text })
  const prompts = (): { text: string; sessionId: string; pid: number }[] => {
    const file = `${claudeStub.launchLog}.user-prompts.jsonl`
    return existsSync(file)
      ? readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : []
  }
  await composer.fill('opener slow')
  await send.click()
  await expect(stop).toBeVisible()
  await composer.fill('A hold-echo')
  await send.click()
  await card('A hold-echo').getByRole('button', { name: 'Steer', exact: true }).click()
  await expect.poll(() => existsSync(`${claudeStub.launchLog}.held`)).toBe(true)

  await composer.fill('B: check the remote session')
  await send.click()
  await card('B: check the remote session')
    .getByRole('button', { name: 'Steer', exact: true })
    .click()
  await expect(composer).toBeEditable()
  await composer.fill('C: cancel this follow-up')
  await send.click()
  await card('C: cancel this follow-up')
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await expect(card('C: cancel this follow-up')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('before-provider-echo.png') })

  const terminalTab = page.locator('[data-testid="sortable-tab"]').first()
  await terminalTab.click()
  await expect(tab).toHaveAttribute('data-active', 'false')
  // The provider sees B before A echoes or the active turn ends.
  await expect
    .poll(() => prompts().map((p) => p.text))
    .toEqual(['opener slow', 'A hold-echo', 'B: check the remote session'])
  expect(new Set(prompts().map((p) => `${p.pid}:${p.sessionId}`)).size).toBe(1)
  writeFileSync(`${claudeStub.launchLog}.release-echo`, '')
  writeFileSync(`${claudeStub.launchLog}.finish-turn`, '')
  await tab.click()
  await expect(chat.getByText('Stub reply.')).toBeVisible()
  await expect(chat.locator('[data-queued-message-id]')).toHaveCount(0)
  await expect(composer).toBeEditable()
  expect(prompts().map((p) => p.text)).toEqual([
    'opener slow',
    'A hold-echo',
    'B: check the remote session'
  ])
  await page.screenshot({ path: testInfo.outputPath('after-provider-echo.png') })
})

test('delivers an accepted steer on the original host after switching workspaces', async ({
  orcaPage: page,
  claudeStub
}, testInfo) => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.evaluate(() =>
    window.__store!.getState().updateSettings({ uiLanguage: 'en', nativeChatQueueFollowUps: true })
  )
  const { composer, send } = await openStubChat(page, claudeStub.command)
  const chat = page.locator('[data-native-chat-root="true"]')
  const prompts = (): { text: string; sessionId: string; pid: number }[] =>
    readFileSync(`${claudeStub.launchLog}.user-prompts.jsonl`, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  await composer.fill('A hold-echo')
  await send.click()
  await expect.poll(() => existsSync(`${claudeStub.launchLog}.held`)).toBe(true)
  await composer.fill('B: deliver in the original workspace')
  await send.click()
  const card = chat
    .locator('[data-queued-message-id]')
    .filter({ hasText: 'B: deliver in the original workspace' })
  await card.getByRole('button', { name: 'Steer', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Steer', exact: true })).toHaveCount(0)
  expect(prompts().map((p) => p.text)).toEqual(['A hold-echo'])
  const { pid, sessionId } = prompts()[0]!
  await page.screenshot({ path: testInfo.outputPath('accepted-before-workspace-switch.png') })

  const other = page
    .locator('[data-worktree-sidebar] [role="option"][data-worktree-id]')
    .filter({ hasText: 'e2e-secondary' })
  await other.click()
  await expect(card).not.toBeVisible()
  writeFileSync(`${claudeStub.launchLog}.release-echo`, '')
  await expect.poll(prompts).toEqual([
    { text: 'A hold-echo', pid, sessionId },
    { text: 'B: deliver in the original workspace', pid, sessionId }
  ])
  await expect(
    page
      .locator('[data-native-chat-root="true"]:visible')
      .getByText('B: deliver in the original workspace', { exact: true })
  ).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('delivered-while-workspace-away.png') })
  writeFileSync(`${claudeStub.launchLog}.finish-turn`, '')
})
