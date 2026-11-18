// An automation a chat's agent creates or edits shows as a card in that chat, and Open goes to it.

import type { Page } from '@stablyai/playwright-test'
import { z } from 'zod'
import { expect } from '@stablyai/playwright-test'
import { waitForSessionReady } from '../../desktop/renderer-probes/store'
import { buildFakeAgentCommandOverride } from '../session-fixtures/fake-agent-command-override'
import { SUPPORTED, test } from '../session-fixtures/structured-claude-stub'

async function call<T>(page: Page, method: string, params: unknown, schema: z.ZodType<T>) {
  const reply = await page.evaluate(
    ({ method, params }) => window.api.runtime.call({ method, params }),
    { method, params }
  )
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
  return schema.parse(z.object({ result: z.unknown() }).parse(reply).result)
}

test.describe('native chat automation card', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('created and updated automations show in the chat that saved them; Open goes to the automation', async ({
    orcaPage: page,
    claudeStub
  }) => {
    // One app launch and one agent turn.
    test.setTimeout(120_000)
    await waitForSessionReady(page)
    await page.evaluate(async (command) => {
      await window.__store?.getState().updateSettings({
        agentCmdOverrides: { claude: command }
      })
    }, buildFakeAgentCommandOverride(claudeStub.command))

    const { bot } = await call(
      page,
      'bots.create',
      { name: 'Atlas', agent: 'claude' },
      z.object({ bot: z.object({ id: z.string() }) })
    )
    // Its row re-renders as the welcome turn lands; the Home Chat row under it opens the chat.
    await page
      .locator(`[data-bot-sidebar-entry="local/${bot.id}"]`)
      .getByText('Home Chat', { exact: true })
      .click()
    // A new bot's Home can open behind a terminal its workspace creates; select it.
    await page.locator('[data-tab-id]').filter({ hasText: 'Home' }).first().click()
    const chat = page.locator('[data-native-chat-root="true"]')
    await chat.getByRole('textbox').click()
    await page.keyboard.type('Set up a morning digest.')
    await chat.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(chat.getByText('Stub reply.').last()).toBeVisible({ timeout: 30_000 })

    const Bots = z.object({
      bots: z.array(z.object({ id: z.string(), chatSessionId: z.string().nullable() }))
    })
    const callerSessionId = (await call(page, 'bots.list', null, Bots)).bots.find(
      (row) => row.id === bot.id
    )?.chatSessionId
    expect(callerSessionId).toBeTruthy()

    // What `orca automations create` sends from inside this chat.
    const { automation } = await call(
      page,
      'automation.create',
      {
        name: 'Morning digest',
        prompt: 'Summarize the morning.',
        agentId: 'claude',
        bot: { botId: bot.id, runsIn: 'new', resultsTo: 'chat' },
        workspaceMode: 'existing',
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30',
        dtstart: Date.now(),
        callerSessionId
      },
      z.object({ automation: z.object({ id: z.string() }) })
    )
    const created = chat.getByText('Created automation')
    await expect(created).toBeVisible({ timeout: 15_000 })
    // The row folds its facts; open it to read them.
    await chat.getByRole('button', { name: /Created automation/ }).click()
    await expect(chat.getByText(/results to Chat$/)).toBeVisible()
    await chat.screenshot({ path: test.info().outputPath('01-created.png') })

    await call(
      page,
      'automation.update',
      { id: automation.id, updates: { name: 'Evening digest', enabled: false }, callerSessionId },
      z.unknown()
    )
    await expect(chat.getByText('Updated automation')).toBeVisible({ timeout: 15_000 })
    await chat.getByRole('button', { name: /Updated automation/ }).click()
    await expect(chat.getByText('Evening digest')).toBeVisible()
    await expect(chat.getByText(/results to Chat · paused$/)).toBeVisible()
    await chat.screenshot({ path: test.info().outputPath('02-updated.png') })

    await chat.getByRole('button', { name: 'Open full page', exact: true }).last().click()
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().activeView))
      .toBe('automations')
    await expect(page.getByText('Evening digest').filter({ visible: true }).first()).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('03-opened.png') })
  })
})
