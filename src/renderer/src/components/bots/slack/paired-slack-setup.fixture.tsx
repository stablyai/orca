import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { publishBots, stampBotHost } from '@/lib/bot-catalog-snapshot'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { BotSlackSetupDialog } from './BotSlackSetupDialog'

// A bot on m4 air (its own Orca account), set up from a desktop signed in as alice@example.com,
// whose own Release bot is already in Acme.
const base: Bot = {
  id: 'bot-release',
  name: 'Bot-Release-Manager',
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
const serverBot = stampBotHost('runtime:m4', base)
const mine: Bot = { ...base, id: 'bot-mine', name: 'Scout', slack: { appId: 'A0', teamId: 'T1' } }
const mineInLabs: Bot = { ...mine, id: 'bot-labs', slack: { appId: 'A2', teamId: 'T2' } }

const AUTHORIZE = 'https://slack.com/oauth/v2/authorize?client_id=1&state=s'
const ok = (value: unknown) => ({ ok: true, result: { ok: true, value } })
const answered = (result: unknown) => ({ ok: true, result })

const m4: PublicKnownRuntimeEnvironment = {
  id: 'm4',
  name: 'm4 air',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: 'm4'
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
}

const LONG_EMAIL = 'alexandra.konstantinopoulou-whitfield@engineering.example.com'
const longBot = stampBotHost('runtime:m4', {
  ...base,
  name: 'Quarterly Planning Assistant for the Northwest Regional Team'
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
      switch (method) {
        case 'status.get':
          return createCompatibleRuntimeStatusResponse('m4')
        case 'bots.list':
          return answered({ bots: [scene.long ? longBot : base] })
        case 'orcaAccount.status':
          return answered({ state: 'signed-in', email: scene.serverEmail ?? 'm4air@example.com' })
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
  runtimeEnvironments: [m4],
  runtimeStatusByEnvironmentId: new Map([
    ['m4', { status: createCompatibleRuntimeStatusResponse('m4').result, checkedAt: 1 }]
  ]),
  orcaProfileAuthStatus: {
    activeProfileId: 'p1',
    configured: true,
    state: 'connected' as const,
    persistence: 'encrypted' as const,
    cloud: {
      cloudProfileId: 'c1',
      userId: 'u1',
      email: 'alice@example.com',
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
  runtimeEnvironments: [{ ...m4, name: 'studio-mac-mini-build-machine-second-floor' }],
  orcaProfileAuthStatus: {
    ...store.orcaProfileAuthStatus,
    cloud: { ...store.orcaProfileAuthStatus.cloud, email: LONG_EMAIL }
  }
}

const dialog = (bot: Bot) => () => (
  <ConfirmationDialogProvider>
    <BotSlackSetupDialog bot={bot} open onOpenChange={() => {}} />
  </ConfirmationDialogProvider>
)

/** `width`: the dialog's, from its narrowest (340) to its widest (512); none leaves it as drawn. */
function scene(fields: Scene, interact: () => Promise<void>, width?: number) {
  return defineFixture({
    width: 720,
    store: fields.long ? longStore : store,
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
  { server: { state: 'not_created' }, serverEmail: 'alice@example.com' },
  () => whenShown('Configuration refresh token')
)

// The option line, above today's dialog.
export const offer = scene({ server: { state: 'not_created' } }, () => whenShown('Use it'))

// One line per workspace.
export const offerTwoWorkspaces = scene(
  { server: { state: 'not_created' }, mineInLabs: true },
  () => whenShown('Acme Labs')
)

// After Use it: the confirm line while the app is made.
export const handingOff = scene(
  { server: { state: 'not_created' }, handOffPending: true },
  async () => {
    await whenShown('Use it', 'Use it →')
    await whenShown('Setting up your Slack app')
  }
)

// The install step: Approve in Slack, and the quiet Copy link.
export const ready = scene({ server: { state: 'created', teamId: 'T1', appId: 'A1' } }, () =>
  whenShown('Approve in Slack')
)

// After Copy link: the dialog waits.
export const waitingCopied = scene(
  { server: { state: 'created', teamId: 'T1', appId: 'A1' } },
  async () => {
    await whenShown('Approve in Slack', 'Copy link')
    await whenShown('Link copied')
  }
)

export const expired = scene(
  { server: { state: 'created', teamId: 'T1', appId: 'A1' }, expiresInMs: -1 },
  () => whenShown('expired')
)

export const otherUser = scene(
  { server: { state: 'created', teamId: 'T1', appId: 'A1', oauthFailure: 'other_user' } },
  async () => {
    await whenShown('Approve in Slack', 'Copy link')
    await whenShown('Another Slack account')
  }
)

// The server's token lapsed in a workspace this desktop's own account has one for: Use it first.
const lapsed: Scene = { server: { state: 'grant_expired', teamId: 'T1' } }
const lapsedLong: Scene = { ...lapsed, long: true }
// No working token anywhere: the server is on this desktop's own account, so nothing is offered.
const lapsedNone: Scene = { ...lapsed, serverEmail: 'alice@example.com' }
const lapsedNoneLong: Scene = { ...lapsedNone, long: true, serverEmail: LONG_EMAIL }

export const reconnectUse = scene(lapsed, () => whenShown('Use it'), 480)
export const reconnectUse340 = scene(lapsed, () => whenShown('Use it'), 340)
export const reconnectUseLong340 = scene(lapsedLong, () => whenShown('Use it'), 340)
export const reconnectUseLong480 = scene(lapsedLong, () => whenShown('Use it'), 480)
export const reconnectUseWhy340 = scene(
  lapsedLong,
  async () => {
    await whenShown('Use it')
    await openWhy()
  },
  340
)
export const reconnectUsePaste340 = scene(
  lapsedLong,
  async () => {
    await whenShown('Use it')
    await clickButton(/Paste a token instead/)
  },
  340
)
export const reconnectUsePaste480 = scene(
  lapsedLong,
  async () => {
    await whenShown('Use it')
    await clickButton(/Paste a token instead/)
  },
  480
)
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
