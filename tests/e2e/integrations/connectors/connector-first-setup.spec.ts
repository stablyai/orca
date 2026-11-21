// A fresh account's bots hold no connector connection until one gets a webhook or a Slack app, whose
// first setup the cloud takes only for a bot a hello has listed; the last one's removal lets it go.
import { z } from 'zod'
import { expect } from '@stablyai/playwright-test'
import { SUPPORTED, test as stubTest } from '../../agents/session-fixtures/structured-claude-stub'
import { orcaCliResult } from '../../desktop/cli-invocation/compiled-orca-cli'
import { createBotAsOwner } from '../bots/create-bot-as-owner'
import {
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
      ORCA_CLOUD_CLIENT_ID: 'connector-first-setup-e2e',
      ORCA_RELAY_URL: UNUSED_RELAY_URL,
      ORCA_CLOUD_DEV_AUTH: '1',
      ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION: '1',
      ORCA_CONNECTOR_URL: connectorCloud.origin
    })
  }
})

test.skip(!SUPPORTED, 'the stub Claude runs through a POSIX wrapper')

const Created = z.object({ bot: z.object({ id: z.string() }) })
const AutomationCreated = z.object({ automation: z.object({ id: z.string() }) })

test('first webhook and first Slack app connect a fresh bot; removing the last lets go', async ({
  electronApp,
  orcaPage: page,
  connectorCloud
}) => {
  // Two bot creations, CLI round trips and a poll that may wait 60s for the client to stop.
  test.setTimeout(180_000)
  const signedIn = await page.evaluate(() => window.api.orcaProfiles.connectCurrent())
  expect(signedIn.status).toBe('connected')
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const createBot = async (name: string) => Created.parse(await createBotAsOwner(page, name)).bot

  const hooky = await createBot('Hooky')
  expect(connectorCloud.helloCount()).toBe(0)

  // The mint is refused for a bot no hello listed, so this passes only if setup said hello first.
  const { automation } = AutomationCreated.parse(
    await orcaCliResult(userDataDir, [
      'automations',
      'create',
      '--name',
      'On call',
      '--bot',
      'Hooky',
      '--on',
      'webhook.call',
      '--prompt',
      'Say hi.'
    ])
  )
  expect(connectorCloud.knownBots()).toContain(hooky.id)

  const scout = await createBot('Scout')
  const setUp = await page.evaluate(
    async (params) => {
      const answer = await window.api.runtime.call({ method: 'bots.slack.setUpApp', params })
      return answer.ok ? answer.result : null
    },
    { botId: scout.id, teamId: ACTIONS_TEAM }
  )
  expect(setUp).toMatchObject({ ok: true })
  expect(connectorCloud.knownBots()).toContain(scout.id)

  await orcaCliResult(userDataDir, ['automations', 'remove', automation.id])
  await page.evaluate(async (botId) => {
    const updated = await window.api.runtime.call({
      method: 'bots.update',
      params: { botId, updates: { slack: null, slackApps: [] } }
    })
    if (!updated.ok) {
      throw new Error(updated.error.message)
    }
  }, scout.id)
  // The poll cycles every second while held; a stopped client sends none.
  await expect
    .poll(() => Date.now() - connectorCloud.lastPollAt(), { timeout: 60_000 })
    .toBeGreaterThan(5_000)
})
