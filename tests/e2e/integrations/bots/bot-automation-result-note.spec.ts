// An automation run's result lands as a note in its bot's Chat and rides, once, with the next message.

import { existsSync, readFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { z } from 'zod'
import { expect } from '@stablyai/playwright-test'
import { waitForSessionReady } from '../../desktop/renderer-probes/store'
import { buildFakeAgentCommandOverride } from '../../agents/session-fixtures/fake-agent-command-override'
import { SUPPORTED, test } from '../../agents/session-fixtures/structured-claude-stub'

async function call<T>(page: Page, method: string, params: unknown, schema: z.ZodType<T>) {
  const reply = await page.evaluate(
    ({ method, params }) => window.api.runtime.call({ method, params }),
    { method, params }
  )
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
  return schema.parse(z.object({ result: z.unknown() }).parse(reply).result)
}

/** The words of each message the stub agent was sent, in order. */
function sentToAgent(inputLog: string): string[] {
  if (!existsSync(inputLog)) {
    return []
  }
  const Message = z.object({
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.string(), text: z.string().optional() }))
    ])
  })
  return readFileSync(inputLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const { content } = Message.parse(JSON.parse(line))
      return typeof content === 'string'
        ? content
        : content.map((block) => block.text ?? '').join('')
    })
}

test.describe('bot automation result notes', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('a run leaves a note; the next message carries it to the agent, and the one after does not', async ({
    orcaPage: page,
    claudeStub
  }) => {
    // One app launch, an automation run and two agent turns.
    test.setTimeout(180_000)
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
        dtstart: Date.now()
      },
      z.object({ automation: z.object({ id: z.string() }) })
    )
    await call(page, 'automation.runNow', { id: automation.id }, z.unknown())
    const Runs = z.object({ runs: z.array(z.object({ status: z.string() })) })
    await expect
      .poll(
        async () =>
          (await call(page, 'automation.runs', { automationId: automation.id }, Runs)).runs[0]
            ?.status,
        { timeout: 60_000 }
      )
      .toBe('completed')
    // The run's own turn was the agent's only input so far.
    expect(sentToAgent(claudeStub.inputLog)).toHaveLength(1)

    await page.getByText('Atlas', { exact: true }).first().click()
    const chat = page.locator('[data-native-chat-root="true"]')
    const note = chat.getByRole('button', { name: /Morning digest finished/ })
    await expect(note).toBeVisible({ timeout: 30_000 })
    await note.click()
    await expect(chat.getByText(/hasn't read this yet/)).toBeVisible()

    const composer = chat.getByRole('textbox')
    const send = chat.getByRole('button', { name: 'Send', exact: true })
    await composer.click()
    await page.keyboard.type('What came in?')
    await send.click()
    await expect.poll(() => sentToAgent(claudeStub.inputLog).length, { timeout: 30_000 }).toBe(2)
    const carried = sentToAgent(claudeStub.inputLog)[1]!
    expect(carried).toMatch(
      /^\[Since your last message: 1 automation result arrived in this chat\./
    )
    expect(carried).toContain('Morning digest, finished: Stub reply.]')
    expect(carried.endsWith(']\n\nWhat came in?')).toBe(true)
    await expect(chat.getByText('Sent with 1 automation result')).toBeVisible()
    await expect(chat.getByText(/read this with your next message/)).toBeVisible()

    await expect(chat.getByText('Stub reply.').last()).toBeVisible({ timeout: 30_000 })
    await expect(chat.getByRole('button', { name: 'Stop the agent' })).toHaveCount(0, {
      timeout: 30_000
    })
    await composer.click()
    await page.keyboard.type('Anything else?')
    await send.click()
    await expect.poll(() => sentToAgent(claudeStub.inputLog).length, { timeout: 30_000 }).toBe(3)
    expect(sentToAgent(claudeStub.inputLog)[2]).toBe('Anything else?')
  })
})
