import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { publishBots, stampBotHost } from '@/lib/bot-catalog-snapshot'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { BotSlackSetupDialog } from './BotSlackSetupDialog'

// A bot on build-box (its own Orca account), set up from a desktop signed in as alex@example.com,
// whose own Release bot is already in Acme.
const base: Bot = {
  id: 'bot-release',
  name: 'Release Helper',
  hostId: 'local',
  folder: 'release',
  folderWorkspaceId: 'fw-release',
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
const serverBot = stampBotHost('runtime:build-box', base)
const mine: Bot = { ...base, id: 'bot-mine', name: 'Scout', slack: { appId: 'A0', teamId: 'T1' } }
const mineInLabs: Bot = { ...mine, id: 'bot-labs', slack: { appId: 'A2', teamId: 'T2' } }

const AUTHORIZE = 'https://slack.com/oauth/v2/authorize?client_id=1&state=s'
// This desktop, by the name other computers see.
const USE_HERE = 'Use MacBook Pro’s sign-in'
const ok = (value: unknown) => ({ ok: true, result: { ok: true, value } })
const answered = (result: unknown) => ({ ok: true, result })

const buildBox: PublicKnownRuntimeEnvironment = {
  id: 'build-box',
  name: 'build-box',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: 'build-box'
}

type Scene = {
  server: ConnectorBotSlackState
  /** setUpApp's link lives this long from now; negative is already past. */
  expiresInMs?: number
  /** The server's Orca account; the hand-off line shows only for another one. */
  serverEmail?: string
  mineInLabs?: boolean
  handOffPending?: boolean
  /** The longest bot, computer and account names, to check they end in an ellipsis. */
  long?: boolean
  /** This desktop's own account is read only after the step shows, so its offer arrives late. */
  signedInLate?: boolean
  /** The server's hand-off refusal, from its Orca Cloud. */
  handOffError?: string
  /** The server dropped: every call to it fails, and its status says it is reconnecting, or gave up. */
  reconnecting?: 'retrying' | 'stopped'
}

const LONG_EMAIL = 'alexandra.konstantinopoulou-whitfield@engineering.example.com'
const longBot = stampBotHost('runtime:build-box', {
  ...base,
  name: 'Release Helper with a Very Long Made-Up Example Name'
})

// The web preload's namespace, kept apart from the methods a scene answers.
const existing = (value: unknown): object => (typeof value === 'object' && value ? value : {})

function stub(scene: Scene): void {
  publishBots(scene.mineInLabs ? [mine, mineInLabs] : [mine])
  const teamNames: Record<string, string> = { T1: 'Acme', T2: 'Acme Labs' }
  Reflect.set(window.api, 'runtime', {
    ...existing(window.api.runtime),
    call: async ({ method, params }: { method: string; params?: { botId?: string } }) => {
      if (method === 'bots.list') {
        return answered({ bots: scene.mineInLabs ? [mine, mineInLabs] : [mine] })
      }
      if (method === 'bots.slack.state') {
        const own = params?.botId === mineInLabs.id ? mineInLabs : mine
        const teamId = own.slack?.teamId ?? 'T1'
        return ok({
          state: 'installed',
          teamId,
          teamName: teamNames[teamId],
          appId: own.slack?.appId,
          botUserId: 'UB',
          installerUserId: 'U1'
        })
      }
      return { ok: false, error: { code: 'runtime_error', message: method } }
    }
  })
  Reflect.set(window.api, 'runtimeEnvironments', {
    ...existing(window.api.runtimeEnvironments),
    call: async ({ method }: { method: string }) => {
      if (scene.reconnecting) {
        return { ok: false, error: { code: 'runtime_error', message: method } }
      }
      switch (method) {
        case 'status.get':
          return createCompatibleRuntimeStatusResponse('build-box')
        case 'bots.list':
          return answered({ bots: [scene.long ? longBot : base] })
        case 'orcaAccount.status':
          return answered({ state: 'signed-in', email: scene.serverEmail ?? 'builder@example.com' })
        case 'bots.slack.state':
          return ok(scene.server)
        case 'bots.slack.setUpApp':
          return ok({
            appId: 'A1',
            authorizeUrl: AUTHORIZE,
            expiresAt: Date.now() + (scene.expiresInMs ?? 30 * 60_000)
          })
        case 'bots.slack.handOff':
          return scene.handOffPending
            ? new Promise(() => {})
            : scene.handOffError
              ? answered({ ok: false, error: scene.handOffError })
              : ok({ code: 'c', expiresAt: Date.now() + 300_000 })
        default:
          return { ok: false, error: { code: 'runtime_error', message: method } }
      }
    }
  })
  Reflect.set(window.api, 'ui', {
    ...existing(window.api.ui),
    writeClipboardText: async () => {}
  })
  Reflect.set(window.api, 'slackHandOff', {
    redeem: async () => ({ ok: true, value: { appId: 'A1', authorizeUrl: AUTHORIZE } })
  })
}

const store = {
  settings: { ...getDefaultSettings('/home/fixture'), machineName: 'MacBook Pro' },
  runtimeEnvironments: [buildBox],
  runtimeStatusByEnvironmentId: new Map([
    [
      'build-box',
      { status: createCompatibleRuntimeStatusResponse('build-box').result, checkedAt: 1 }
    ]
  ]),
  orcaProfileAuthStatus: {
    activeProfileId: 'p1',
    configured: true,
    state: 'connected' as const,
    persistence: 'encrypted' as const,
    cloud: {
      cloudProfileId: 'c1',
      userId: 'u1',
      email: 'alex@example.com',
      linkedAt: 1
    }
  }
}

async function whenShown(text: string, click?: string): Promise<void> {
  for (let tries = 0; tries < 60; tries++) {
    if (document.body.textContent?.includes(text)) {
      const button = click
        ? [...document.querySelectorAll('button')].find(
            (candidate) => candidate.textContent?.trim() === click
          )
        : null
      button?.click()
      if (click && !button) {
        continue
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const longStore = {
  ...store,
  runtimeEnvironments: [{ ...buildBox, name: 'build-box-with-a-very-long-made-up-example-name' }],
  orcaProfileAuthStatus: {
    ...store.orcaProfileAuthStatus,
    cloud: { ...store.orcaProfileAuthStatus.cloud, email: LONG_EMAIL }
  }
}

// Signed in, with the account not read yet: nothing to offer until it is.
const lateStore = {
  ...store,
  orcaProfileAuthStatus: { ...store.orcaProfileAuthStatus, cloud: undefined }
}

const droppedStore = (state: 'reconnecting' | 'closed') => ({
  ...store,
  runtimeStatusByEnvironmentId: new Map([
    [
      'build-box',
      {
        status: {
          ...createCompatibleRuntimeStatusResponse('build-box').result,
          remoteControl: {
            state,
            pendingRequestCount: 0,
            subscriptionCount: 0,
            reconnectAttempt: 1,
            lastConnectedAt: 1,
            lastClose: null,
            lastError: null
          }
        },
        checkedAt: 1
      }
    ]
  ])
})

const dialog = (bot: Bot) => () => (
  <ConfirmationDialogProvider>
    <BotSlackSetupDialog bot={bot} open onOpenChange={() => {}} />
  </ConfirmationDialogProvider>
)

/** `width`: the dialog's, from its narrowest (340) to its widest (512); none leaves it as drawn. */
function scene(fields: Scene, interact: () => Promise<void>, width?: number) {
  return defineFixture({
    width: 720,
    store: fields.long
      ? longStore
      : fields.signedInLate
        ? lateStore
        : fields.reconnecting
          ? droppedStore(fields.reconnecting === 'retrying' ? 'reconnecting' : 'closed')
          : store,
    setup: () => stub(fields),
    render: dialog(fields.long ? longBot : serverBot),
    interact: async () => {
      // Portaled and centred in the page whatever the frame's width, so the dialog is sized itself.
      const content = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')
      if (content && width !== undefined) {
        content.style.maxWidth = `${width}px`
      }
      await interact()
    }
  })
}

async function clickButton(name: RegExp): Promise<void> {
  ;[...document.querySelectorAll('button')]
    .find((candidate) => name.test(candidate.textContent ?? ''))
    ?.click()
  await new Promise((resolve) => setTimeout(resolve, 100))
}

// Opened from the keyboard, as a Tab onto it does.
async function openWhy(): Promise<void> {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  document.querySelector<HTMLButtonElement>('button[aria-label="About Slack tokens"]')?.focus()
  await new Promise((resolve) => setTimeout(resolve, 300))
}

// Today's dialog, unchanged: the server is on this desktop's own account.
export const sameAccount = scene(
  { server: { state: 'not_created' }, serverEmail: 'alex@example.com' },
  () => whenShown('Configuration refresh token')
)

// First setup, one workspace: this desktop's sign-in first, the token form behind Set up another way.
export const offer = scene({ server: { state: 'not_created' } }, () => whenShown(USE_HERE))

export const offerAnotherWay = scene({ server: { state: 'not_created' } }, () =>
  whenShown(USE_HERE, 'Set up another way')
)

// First setup: a token typed before this desktop's account is read keeps the form when the offer lands.
export const offerLateWhileTyping = scene(
  { server: { state: 'not_created' }, signedInLate: true },
  async () => {
    await whenShown('Configuration refresh token')
    const field = document.querySelector<HTMLInputElement>('input[type="password"]')
    field?.focus()
    if (field) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        field,
        'xoxe-1-made-up-example-token'
      )
      field.dispatchEvent(new Event('input', { bubbles: true }))
    }
    useAppStore.setState({ orcaProfileAuthStatus: store.orcaProfileAuthStatus })
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
)

// One line per workspace.
export const offerTwoWorkspaces = scene(
  { server: { state: 'not_created' }, mineInLabs: true },
  () => whenShown('Acme Labs')
)

// After the offer is taken: the confirm line while the app is made.
export const handingOff = scene(
  { server: { state: 'not_created' }, handOffPending: true },
  async () => {
    await whenShown(USE_HERE, USE_HERE)
    await whenShown('Setting up your Slack app')
  }
)

// The install step: Open Slack on the server, the link for another device folded away.
export const ready = scene({ server: { state: 'created', teamId: 'T1', appId: 'A1' } }, () =>
  whenShown('Open Slack on build-box')
)

export const readyOtherDevice = scene(
  { server: { state: 'created', teamId: 'T1', appId: 'A1' } },
  () => whenShown('Open Slack on build-box', 'Approve on another device')
)

// After Copy link: the same step, waiting on Slack.
export const waitingCopied = scene(
  { server: { state: 'created', teamId: 'T1', appId: 'A1' } },
  async () => {
    await whenShown('Open Slack on build-box', 'Approve on another device')
    await whenShown('Copy link', 'Copy link')
    await whenShown('Copied')
  }
)

export const expired = scene(
  { server: { state: 'created', teamId: 'T1', appId: 'A1' }, expiresInMs: -1 },
  () => whenShown('expired')
)

export const otherUser = scene(
  { server: { state: 'created', teamId: 'T1', appId: 'A1', oauthFailure: 'other_user' } },
  async () => {
    await whenShown('Open Slack on build-box', 'Approve on another device')
    await whenShown('Copy link', 'Copy link')
    await whenShown('different Slack account')
  }
)

// The server dropped mid-setup: the dialog waits for it, as the bot's page does.
export const hostReconnecting = scene(
  { server: { state: 'created', teamId: 'T1', appId: 'A1' }, reconnecting: 'retrying' },
  () => whenShown('Close')
)

// Retries stopped: Reconnect, as the bot's page offers.
export const hostOffline = scene(
  { server: { state: 'created', teamId: 'T1', appId: 'A1' }, reconnecting: 'stopped' },
  () => whenShown('Close')
)

// Slack no longer accepts the workspace's token: Use it fails at the server.
const rejected: Scene = { server: { state: 'not_created' }, handOffError: 'grant_expired' }
export const tokenRejected = scene(rejected, async () => {
  await whenShown('Use it', 'Use it →')
  await whenShown('Close')
})

// Details opened: the codes for support, kept out of the sentence above.
export const tokenRejectedDetails = scene(rejected, async () => {
  await whenShown('Use it', 'Use it →')
  await whenShown('Close', 'Details')
})

// The server's token lapsed in a workspace this desktop's own account has one for: its sign-in first.
const lapsed: Scene = { server: { state: 'grant_expired', teamId: 'T1' } }
const lapsedLong: Scene = { ...lapsed, long: true }
// No working token anywhere: the server is on this desktop's own account, so nothing is offered.
const lapsedNone: Scene = { ...lapsed, serverEmail: 'alex@example.com' }
const lapsedNoneLong: Scene = { ...lapsedNone, long: true, serverEmail: LONG_EMAIL }

export const reconnectUse = scene(lapsed, () => whenShown(USE_HERE), 480)
export const reconnectUse340 = scene(lapsed, () => whenShown(USE_HERE), 340)
export const reconnectUseLong340 = scene(lapsedLong, () => whenShown(USE_HERE), 340)
export const reconnectUseLong480 = scene(lapsedLong, () => whenShown(USE_HERE), 480)
export const reconnectUsePaste340 = scene(
  lapsedLong,
  async () => {
    await whenShown(USE_HERE)
    await clickButton(/Sign in again/)
  },
  340
)
export const reconnectUsePaste480 = scene(
  lapsedLong,
  async () => {
    await whenShown(USE_HERE)
    await clickButton(/Sign in again/)
  },
  480
)
// A token typed into the paste-only step, then this desktop's account is read: the offer arrives
// with the typed token still in view and focused.
const lapsedLate: Scene = { ...lapsed, signedInLate: true }
async function typeThenSignIn(): Promise<void> {
  await whenShown('Paste a new token')
  const field = document.querySelector<HTMLInputElement>('input[type="password"]')
  if (field) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      field,
      'xoxe-1-made-up-example-token'
    )
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  useAppStore.setState({ orcaProfileAuthStatus: store.orcaProfileAuthStatus })
  await whenShown(USE_HERE)
}
export const reconnectLateOffer340 = scene(lapsedLate, typeThenSignIn, 340)

export const reconnectPaste = scene(lapsedNone, () => whenShown('Paste a new token'), 480)
export const reconnectPaste340 = scene(lapsedNone, () => whenShown('Paste a new token'), 340)
export const reconnectPasteLong340 = scene(
  lapsedNoneLong,
  () => whenShown('Paste a new token'),
  340
)
export const reconnectPasteLong480 = scene(
  lapsedNoneLong,
  () => whenShown('Paste a new token'),
  480
)
export const reconnectPasteWhy340 = scene(
  lapsedNoneLong,
  async () => {
    await whenShown('Paste a new token')
    await openWhy()
  },
  340
)
