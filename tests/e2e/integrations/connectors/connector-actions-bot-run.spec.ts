// A bot's automation run reacts, reads and posts through `orca slack`, as itself, via its host and Orca Cloud.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { expect } from '@stablyai/playwright-test'
import { SUPPORTED, test as stubTest } from '../../agents/session-fixtures/structured-claude-stub'
import { orcaCliResult } from '../../desktop/cli-invocation/compiled-orca-cli'
import { createBotAsOwner } from '../bots/create-bot-as-owner'
import {
  ACTIONS_FIRST_MESSAGE,
  ACTIONS_PLACE,
  ACTIONS_TEAM,
  startConnectorActionsCloud,
  type ConnectorActionsCloud
} from './connector-actions-cloud-fixture'

// The auth override is all-or-nothing; no relay call is expected, so nothing real may answer.
const UNUSED_RELAY_URL = 'https://127.0.0.1:1'

const test = stubTest.extend<{ connectorCloud: ConnectorActionsCloud }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  connectorCloud: async ({}, provideFixture) => {
    const cloud = await startConnectorActionsCloud()
    await provideFixture(cloud)
    await cloud.close()
  },
  orcaAppExtraEnv: async ({ connectorCloud }, provideFixture) => {
    await provideFixture({
      ORCA_CLOUD_API_URL: connectorCloud.origin,
      ORCA_CLOUD_CLIENT_ID: 'connector-actions-e2e',
      ORCA_RELAY_URL: UNUSED_RELAY_URL,
      ORCA_CLOUD_DEV_AUTH: '1',
      ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION: '1',
      ORCA_CONNECTOR_URL: connectorCloud.origin
    })
  }
})

test.skip(!SUPPORTED, 'the stub Claude runs through a POSIX wrapper')

const Ran = z.object({ ran: z.string(), output: z.string() })

test('a bot run reacts, reads and posts through orca slack', async ({
  electronApp,
  orcaPage: page,
  claudeStub,
  connectorCloud
}) => {
  // One app launch, a dev sign-in, two CLI round trips and an agent turn that runs four more.
  test.setTimeout(180_000)
  const signedIn = await page.evaluate(() => window.api.orcaProfiles.connectCurrent())
  expect(signedIn.status).toBe('connected')

  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const { bot } = z
    .object({ bot: z.object({ id: z.string() }) })
    .parse(await createBotAsOwner(page, 'Scout'))
  // A home-chat-only bot holds no connection; its first Slack app opens one.
  expect(connectorCloud.helloCount()).toBe(0)
  await page.evaluate(
    async ({ botId, teamId }) => {
      const updated = await window.api.runtime.call({
        method: 'bots.update',
        params: { botId, updates: { slackApps: [{ appId: 'A0E2E', teamId }] } }
      })
      if (!updated.ok) {
        throw new Error(updated.error.message)
      }
    },
    { botId: bot.id, teamId: ACTIONS_TEAM }
  )
  await expect.poll(() => connectorCloud.helloCount(), { timeout: 30_000 }).toBeGreaterThan(0)

  // What the bot's agent runs, as its Bash tool would: this build's CLI against this app.
  const cli = [
    `ORCA_USER_DATA_PATH='${userDataDir}'`,
    'ORCA_DEV_CLI_INVOCATION=1',
    `'${process.execPath}'`,
    `'${path.join(process.cwd(), 'out', 'cli', 'index.js')}'`,
    'slack'
  ].join(' ')
  const prompt = [
    'Look at the channel and say hi.',
    `run: ${cli} react ${ACTIONS_FIRST_MESSAGE} 👀`,
    `run: ${cli} read ${ACTIONS_PLACE}`,
    `run: ${cli} post ${ACTIONS_PLACE} 'On it.'`
  ].join('\n')
  const { automation } = z
    .object({ automation: z.object({ id: z.string() }) })
    .parse(
      await orcaCliResult(userDataDir, [
        'automations',
        'create',
        '--name',
        'Channel check',
        '--trigger',
        'daily',
        '--bot',
        'Scout',
        '--prompt',
        prompt
      ])
    )
  await orcaCliResult(userDataDir, ['automations', 'run', automation.id])

  await expect
    .poll(() => connectorCloud.actions.map((action) => action.verb), { timeout: 60_000 })
    .toEqual(['react', 'read', 'post'])
  expect(connectorCloud.actions.every((action) => action.botId === bot.id)).toBe(true)
  expect([...connectorCloud.reactions]).toEqual([`${ACTIONS_FIRST_MESSAGE}:👀`])
  expect(connectorCloud.messages.map((message) => message.text)).toEqual([
    'deploys are failing',
    'On it.'
  ])

  // The agent read each answer as ref and label.
  const ran = readFileSync(claudeStub.launchLog, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const parsed = line ? Ran.safeParse(JSON.parse(line)) : null
      return parsed?.success ? [parsed.data.output] : []
    })
  expect(ran).toHaveLength(3)
  expect(ran[0]).toContain(`${ACTIONS_FIRST_MESSAGE}  👀 added`)
  expect(ran[1]).toContain('Dana wrote')
  expect(ran[2]).toMatch(/^Posted: slack:T0E2E:C0E2E:\S+ {2}#general/)
})
