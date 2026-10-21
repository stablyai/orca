import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { createChatOnHost } from './helpers/structured-claude-stub'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'

test('an answer after the tool wait ends resumes the original native chat', async ({
  orcaPage: page
}, testInfo) => {
  test.skip(
    process.platform !== 'win32',
    'Windows wrapper integration; host contracts cover shared behavior'
  )
  const bin = testInfo.outputPath('stub')
  await mkdir(bin, { recursive: true })
  const command = join(bin, 'claude.cmd')
  const script = resolve('tests/e2e/fixtures/structured-claude-stub.cjs')
  await copyFile(script, join(bin, 'agent.cjs'))
  await writeFile(
    command,
    `@echo off\r\n"${process.execPath}" "%~dp0agent.cjs" "%~dp0launches.jsonl" %*\r\n`
  )
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await page.evaluate(
    async (override) => {
      await window.__store!.getState().updateSettingsOrThrow({
        experimentalNativeChat: true,
        defaultTuiAgent: 'claude',
        agentCmdOverrides: { claude: override }
      })
    },
    buildFakeAgentCommandOverride(command).replace(/^& /, '')
  )
  const sessionId = await createChatOnHost(page, worktreeId)
  await expect
    .poll(async () =>
      page.evaluate(
        ({ worktreeId, sessionId }) =>
          window
            .__store!.getState()
            .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === sessionId)?.id,
        { worktreeId, sessionId }
      )
    )
    .toBeTruthy()

  const id = await page.evaluate(
    ({ worktreeId, sessionId }) =>
      window
        .__store!.getState()
        .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === sessionId)?.id,
    { worktreeId, sessionId }
  )
  await page.locator(`[data-testid="sortable-tab"][data-tab-id="${id}"]`).click()
  const chat = page.locator('[data-native-chat-root="true"]')
  await chat.getByRole('textbox').fill('Initial task before the inbox question')
  await chat.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(chat.getByText('Stub reply.', { exact: true })).toHaveCount(1)
  await expect(chat.getByRole('button', { name: 'Stop the agent' })).toHaveCount(0)
  const question = await page.evaluate(
    (sessionId) =>
      window.api.runtime.call({
        method: 'workInbox.ask',
        params: {
          from: `orca_session_id:${sessionId}`,
          question: 'Continue the original review?',
          options: 'Review,Wait',
          requestId: 'late-chat-answer',
          timeoutMs: 0
        }
      }),
    sessionId
  )
  expect(question).toMatchObject({ ok: true, result: { timedOut: true } })
  await page.getByTestId('sortable-tab').filter({ hasText: 'Terminal 1' }).click()
  await expect(chat).toBeHidden()
  await page.getByRole('button', { name: 'Work Inbox', exact: true }).click()
  const card = page.locator('article').filter({ hasText: 'Continue the original review?' })
  await expect(card).toBeVisible()
  await card.getByRole('checkbox', { name: 'Review', exact: true }).click()
  await expect(chat).toBeHidden()
  await expect(card).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('before-answer-other-tab.png') })
  await card.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Work Inbox' })).toBeHidden()
  await expect(chat).toBeVisible()
  await expect(chat.getByText('Stub reply.', { exact: true })).toHaveCount(2, { timeout: 30000 })
  await expect(chat.getByText(/Answer to Work Inbox question/).first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('late-answer-resumed-chat.png') })
  await page.evaluate(() => window.__store!.getState().updateSettingsOrThrow({ theme: 'dark' }))
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(chat.getByText('Stub reply.', { exact: true })).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('late-answer-resumed-chat-dark.png') })
})
