// The host the Orca sign-in fixtures share: a bot catalog, the cloud's answers signed in and out, and Sign in.
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { cancelConnectorConnect } from '@/lib/connector-connect-state'
import type { Bot } from '../../../../shared/bot-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { ORCA_CONNECTED, ORCA_SIGNED_OUT, orcaSignIn } from './orca-sign-in.test-fixture'
import { webhookSummaryFixture } from './webhooks/webhook-summary.test-fixture'

export const cos: Bot = {
  id: 'bot-cos',
  name: 'CoS',
  hostId: 'local',
  folder: 'cos',
  folderWorkspaceId: 'fw-cos',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
// In Slack, with a webhook: what a signed-out owner finds paused.
export const inSlack: Bot = { ...cos, slack: { appId: 'A1', teamId: 'T1' } }

export const connected = ORCA_CONNECTED
export const signedOut = ORCA_SIGNED_OUT

export const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
const isSignedOut = (): boolean =>
  useAppStore.getState().orcaProfileAuthStatus?.state !== 'connected'

/** Signed out; Sign in waits on the browser, then signs in (or, `waits`, keeps waiting). */
export function signedOutStore(waits = false): Partial<AppState> {
  return {
    orcaProfileAuthStatus: signedOut,
    orcaProfileSignInProgress: null,
    connectCurrentOrcaProfile: orcaSignIn(async () => {
      useAppStore.setState({
        orcaProfileSignInProgress: { link: 'https://orca.example/sign-in?code=fixture' }
      })
      await (waits ? new Promise(() => {}) : settle(300))
      useAppStore.setState({ orcaProfileSignInProgress: null })
    })
  }
}

export async function click(name: string): Promise<void> {
  for (let tries = 0; tries < 60; tries++) {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => !candidate.disabled && candidate.textContent?.trim() === name
    )
    if (button) {
      button.click()
      return
    }
    await settle(50)
  }
}
export const signIn = async (): Promise<void> => {
  await click('Sign in')
  await settle(1500)
}

const notAnswered = async (): Promise<{ ok: false; error: string }> => ({
  ok: false,
  error: 'fixture'
})
const neverReturns = (): Promise<never> => new Promise(() => {})
// The cloud's answer while signed out, else `value`.
const cloud = (value: unknown) => async (): Promise<unknown> =>
  isSignedOut() ? { ok: false, error: 'signed_out' } : { ok: true, value }

export const stablyInstalled = {
  state: 'installed',
  teamId: 'T1',
  teamName: 'Globex',
  appId: 'A1',
  botUserId: 'UB',
  installerUserId: 'U-alice',
  installerName: 'Alice'
}
const deployFinished = webhookSummaryFixture({
  botId: 'bot-cos',
  automationName: 'Deploy finished'
})

// The bots the host lists; a card's answer is kept on its bot.
let listed: Bot[] = []

export function stubCloud(slack: unknown = { state: 'not_created' }): void {
  listed = [inSlack]
  publishBots(listed)
  Reflect.set(window.api, 'botSlack', {
    state: cloud(slack),
    members: notAnswered,
    setUpApp: neverReturns,
    saveGrant: neverReturns
  })
  Reflect.set(window.api, 'botGitHub', {
    state: cloud({
      installUrl: 'https://github.com/apps/orca-ide/installations/new',
      account: { userId: '42', login: 'alice' },
      installations: [],
      defaultBotId: null
    }),
    users: notAnswered,
    connect: neverReturns,
    cancelConnect: async () => undefined
  })
  Reflect.set(window.api, 'botLinear', {
    state: cloud({ installUrl: 'https://connector.example/linear/install', workspaces: [] }),
    members: notAnswered,
    connect: neverReturns,
    cancelConnect: async () => undefined
  })
  Reflect.set(window.api, 'shell', { ...window.api.shell, openUrl: async () => undefined })
  const runtime: unknown = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...(typeof runtime === 'object' ? runtime : {}),
    call: async ({ method }: { method: string }) => {
      if (method === 'webhooks.list') {
        return isSignedOut()
          ? { ok: false, error: { code: 'webhooks_unavailable', message: 'signed out' } }
          : { ok: true, result: { hooks: [deployFinished] } }
      }
      // The chat's answer to the card is kept on the bot, as the host does.
      if (method === 'bots.update') {
        const answered: Bot = {
          ...inSlack,
          offerAnswers: ['m-slack', 'm-webhook'].map((cardId) => ({
            cardId,
            sent: { chosen: [] }
          }))
        }
        listed = [answered]
        publishBots(listed)
        return { ok: true, result: { bot: answered } }
      }
      if (method === 'bots.list') {
        return { ok: true, result: { bots: listed } }
      }
      if (method === 'webhooks.calls') {
        return { ok: true, result: { calls: [] } }
      }
      if (method === 'bots.share.status') {
        return { ok: true, result: { status: 'ok', value: [] } }
      }
      if (method === 'bots.share.prepare') {
        return { ok: true, result: { candidate: shareCandidate } }
      }
      if (method === 'bots.access.list') {
        return {
          ok: true,
          result: isSignedOut() ? { ok: false, error: 'signed_out' } : { ok: true, value: [] }
        }
      }
      return { ok: false, error: { code: 'runtime_error', message: method } }
    }
  })
  cancelConnectorConnect(LOCAL_EXECUTION_HOST_ID, 'linear')
  cancelConnectorConnect(LOCAL_EXECUTION_HOST_ID, 'github')
}

const shareCandidate = {
  candidateId: 'c1',
  packageId: 'package-1',
  versionId: 'version-c1',
  botDigest: 'digest',
  archiveSha256: 'sha',
  compressedBytes: 1,
  fileCount: 1,
  totalBytes: 1,
  bot: {
    schemaVersion: 1,
    name: 'CoS',
    purpose: 'Files new Sentry issues and summarizes deploys.',
    agentHint: 'claude',
    skills: [],
    tools: [],
    connectors: [],
    schedules: [],
    eventSuggestions: [],
    memory: []
  },
  files: [],
  leftOut: [],
  notIncluded: [],
  rewritten: [],
  available: {
    soulLines: 12,
    skills: [],
    schedules: [],
    eventSuggestions: [],
    tools: [],
    memory: [{ topic: 'area-owners', lines: 3 }]
  },
  automationIds: { schedules: [], eventSuggestions: [] },
  flags: [],
  blocked: false,
  expiresAt: '2026-11-11T01:00:00.000Z'
}
