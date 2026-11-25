// The host answers the Connectors fixtures share: a bot catalog, connector state and tool RPCs.
import { withBotConnectorRuntime } from '@/lib/bot-connector-host-calls.test-fixture'
import React from 'react'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { refreshBotGitHub } from '@/lib/bot-github-state'
import { refreshBotLinear } from '@/lib/bot-linear-state'
import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import { resetComposioClientForTest } from './composio/composio-client'
import { resetBotToolSignInsForTest } from './bot-tools-client'
import { retryBotToolCheck } from './bot-tools-revision'
import type { Bot } from '../../../../shared/bot-types'
import type { BotOwnTool } from '../../../../shared/bot-tools'
import type {
  WebhookCallRow,
  WebhookSummary
} from '../../../../shared/rpc-contract/webhooks-params'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import { BotConnectorsSection } from '../settings/bots/BotConnectorsSection'

export const base: Bot = {
  id: 'bot-cos',
  name: 'CoS',
  hostId: 'local',
  folder: 'cos',
  folderWorkspaceId: 'fw-cos',
  agent: 'claude',
  avatar: mascotAvatar('K2'),
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [{ id: 'U-sam', name: 'Sam Lee' }],
  slack: { appId: 'A1', teamId: 'T1' },
  linear: null,
  linearWorkspaces: [{ workspaceId: 'org-globex', workspaceName: 'Globex', urlKey: 'globex' }],
  github: {},
  google: true,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
export const empty: Bot = {
  ...base,
  id: 'bot-new',
  name: 'Scout',
  members: [],
  slack: null,
  linearWorkspaces: [],
  github: null,
  google: false
}

// Only in Slack: its lone row starts closed like any other.
export const slackOnly: Bot = {
  ...base,
  id: 'bot-builder',
  name: 'Bot builder',
  linearWorkspaces: [],
  github: null,
  google: false
}

// In two Slack workspaces; with `sameService`, also in two GitHub orgs and on GitHub through Composio.
export const twoOfEach: Bot = {
  ...base,
  id: 'bot-pair',
  slackApps: [
    { appId: 'A1', teamId: 'T1' },
    { appId: 'A2', teamId: 'T2' }
  ]
}

// Signed in to Vercel on Claude Code, then switched to Codex, whose CLI holds no sign-in for it.
export const switchedToCodex: Bot = { ...base, id: 'bot-codex', agent: 'codex' }

const notAnswered = async (): Promise<{ ok: false; error: string }> => ({
  ok: false,
  error: 'fixture'
})
const neverReturns = (): Promise<never> => new Promise(() => {})

export type StubOptions = {
  linearLinked: boolean
  composio: boolean
  /** The host's bots, listed and answered on every re-read; the shared five by default. */
  bots?: readonly Bot[]
  /** The key's state on each read of the status, the last one repeating. */
  keys?: ('ok' | 'rejected')[]
  /** The sign-ins can't be read. */
  connectionsFail?: boolean
  /** Vercel and a server added by URL, as the bot's tools; Vercel needs sign-in on Codex. */
  tools?: boolean
  /** The bot's tools, when Orca signs in to them (in place of `tools`). */
  owned?: BotOwnTool[]
  /** How a Connect goes: the browser opens and waits, or the app refuses Orca's registration. */
  connect?: 'waiting' | 'unsupported'
  /** The host refuses a new address with this message (Add by URL's sorting). */
  addRefused?: string
  /** Two GitHub orgs, two Slack workspaces, and GitHub signed in through Composio too. */
  sameService?: boolean
  /** The tool the host answers an add with; Vercel, signed out, by default. */
  added?: BotOwnTool
  /** A web or phone window, whose bots run on its paired server: `paste` signs in there by paste;
   *  `finishing` has the pasted address being exchanged; `old-host` runs an Orca that can't. */
  host?: 'paste' | 'finishing' | 'old-host'
  /** The bot's hooks and the calls each one lists; none by default. */
  webhooks?: { hooks: WebhookSummary[]; calls: WebhookCallRow[] }
}

const HOST_PAGE = 'https://mcp.acme-notes.example/authorize?client_id=orca&state=fixture'

export function stub(options: StubOptions): void {
  const bots = options.bots ?? [base, empty, slackOnly, switchedToCodex, twoOfEach]
  publishBots(bots)
  retryBotToolCheck()
  // The page stays warm between fixtures; each starts from no Composio read.
  resetComposioClientForTest()
  resetBotToolSignInsForTest()
  if (options.host) {
    Reflect.set(window, '__ORCA_WEB_CLIENT__', true)
  } else {
    Reflect.deleteProperty(window, '__ORCA_WEB_CLIENT__')
  }
  const keys = options.keys ?? ['ok']
  let statusReads = 0
  // A Connect leaves one read that shows the wait; the next shows it dropped, as after a denial.
  let connectReads = 0
  let waits = 0
  const globex = {
    state: 'installed',
    teamId: 'T1',
    teamName: 'Globex',
    appId: 'A1',
    botUserId: 'UB',
    installerUserId: 'U-carol',
    installerName: 'Carol'
  }
  const acme = {
    ...globex,
    teamId: 'T2',
    teamName: 'Acme Design Partners',
    appId: 'A2',
    botUserId: 'UB2'
  }
  Reflect.set(window.api, 'botSlack', {
    state: async () => ({
      ok: true,
      value: options.sameService ? { ...globex, teams: [globex, acme] } : globex
    }),
    members: notAnswered
  })
  Reflect.set(window.api, 'botLinear', {
    state: async () => ({
      ok: true,
      value: {
        installUrl: 'https://connector.example/linear/install',
        workspaces: options.linearLinked
          ? [
              {
                workspaceId: 'org-globex',
                name: 'Globex',
                urlKey: 'globex',
                installed: true,
                userId: 'L-1',
                userName: 'Carol',
                defaultBotId: null
              }
            ]
          : []
      }
    }),
    members: notAnswered,
    connect: neverReturns
  })
  Reflect.set(window.api, 'botGitHub', {
    state: async () => ({
      ok: true,
      value: {
        installUrl: 'https://github.com/apps/orca-ide/installations/new',
        account: { userId: '42', login: 'cos-orca' },
        installations: [
          ...(options.sameService
            ? [
                {
                  installationId: '2',
                  accountLogin: 'Alice-H',
                  repositories: [{ fullName: 'Alice-H/dotfiles' }]
                }
              ]
            : []),
          { installationId: '1', accountLogin: 'stablyai', repositories: null }
        ],
        defaultBotId: null,
        accounts: [
          {
            userId: '42',
            login: 'cos-orca',
            installations: [...(options.sameService ? ['2'] : []), '1'],
            defaultBotId: null,
            linkedAccounts: []
          }
        ]
      }
    }),
    users: notAnswered,
    connect: neverReturns
  })
  Reflect.set(window.api, 'shell', { ...window.api.shell, openUrl: async () => undefined })
  const answers: Record<string, () => unknown> = {
    'google.status': () => ({
      client: null,
      accounts: [
        {
          email: 'carol@example.com',
          status: 'connected',
          services: [
            { service: 'gmail', state: 'ready' },
            { service: 'calendar', state: 'ready' },
            { service: 'drive', state: 'ready' }
          ],
          connectedAt: 1
        },
        {
          email: 'carol.lee@gmail.com',
          status: 'connected',
          services: [
            { service: 'gmail', state: 'ready' },
            { service: 'calendar', state: 'ready' },
            { service: 'drive', state: 'ready' }
          ],
          connectedAt: 2
        }
      ],
      defaultAccount: 'carol@example.com',
      bots: []
    }),
    'bots.list': () => ({ bots }),
    'webhooks.list': () => ({ hooks: options.webhooks?.hooks ?? [] }),
    'webhooks.calls': () => ({ calls: options.webhooks?.calls ?? [] }),
    'bots.tools.list': () => ({
      agent: 'claude',
      own: options.owned
        ? options.owned
        : options.tools
          ? [
              { name: 'vercel', detail: 'https://mcp.vercel.com', remote: true },
              { name: 'globex-docs', detail: 'https://docs.globex.example/mcp', remote: true }
            ]
          : [],
      inherited: []
    }),
    'bots.tools.problems': () => ({ problems: {} }),
    'bots.tools.context': () => ({
      folder: '/Users/sam/bots/cos',
      platform: 'darwin',
      agent: 'claude'
    }),
    'bots.tools.add': () => {
      if (options.addRefused) {
        throw new Error(options.addRefused)
      }
      return {
        tool: options.added ?? {
          name: 'vercel',
          detail: 'https://mcp.vercel.com',
          remote: false,
          signIn: { state: 'signed-out' }
        }
      }
    },
    'bots.tools.connect': () => {
      if (options.connect === 'unsupported') {
        throw new Error('This app isn’t supported yet.')
      }
      return { attemptId: 'attempt-1', authorizationOrigin: 'https://vercel.com' }
    },
    'bots.tools.signInStatus': () =>
      options.connect === 'unsupported'
        ? { status: 'failed', progress: { state: 'failed', code: 'unsupported' } }
        : {
            status: 'pending',
            progress: {
              state: 'waiting',
              attemptId: 'attempt-1',
              authorizationOrigin: 'https://vercel.com',
              expiresAt: Date.now() + 300_000
            }
          },
    'bots.tools.cancelProblems': () => ({ cancelled: true }),
    'bots.tools.signIn.start': () => ({
      flowId: 'flow-1',
      revision: 1,
      expiresAt: Date.now() + 300_000,
      state: 'waiting',
      authorizationUrl: HOST_PAGE,
      redirectUri: 'http://127.0.0.1:41234/orca/app-callback'
    }),
    // Like the host's long poll: the change once, then nothing until it settles.
    'bots.tools.signIn.wait': () =>
      options.host === 'finishing' && waits++ === 0
        ? { flowId: 'flow-1', revision: 2, expiresAt: Date.now() + 300_000, state: 'finishing' }
        : neverReturns(),
    'bots.composio.status': () => ({
      key: keys[Math.min(statusReads++, keys.length - 1)],
      limit: null,
      added: true
    }),
    'bots.composio.connections': () => {
      if (options.connectionsFail) {
        throw new Error('Composio didn’t answer')
      }
      const pending =
        connectReads > 0
          ? [{ app: 'notion', url: 'https://composio.example/connect', startedAt: 1 }]
          : []
      connectReads = Math.max(0, connectReads - 1)
      return {
        connections: options.composio
          ? [
              {
                id: 'ca-jira',
                app: 'jira',
                name: 'Jira',
                status: 'active',
                label: 'carol@example.com'
              },
              { id: 'ca-figma', app: 'figma', name: 'Figma', status: 'active', label: 'Carol' },
              ...(options.sameService
                ? [
                    {
                      id: 'ca-github',
                      app: 'github',
                      name: 'GitHub',
                      status: 'active',
                      label: 'Alice-H'
                    }
                  ]
                : [])
            ]
          : [],
        pending
      }
    },
    'bots.composio.connect': () => {
      connectReads = 1
      return { url: 'https://composio.example/connect' }
    }
  }
  Reflect.set(window.api, 'runtime', {
    ...window.api.runtime,
    getStatus: async () => ({
      machineName: 'build-box',
      capabilities: options.host === 'old-host' ? [] : ['bots.tools.owned-sign-in.v1']
    }),
    call: async ({ method, params }: { method: string; params?: { botId?: string } }) => {
      if (method === 'bots.tools.problems' && params?.botId === switchedToCodex.id) {
        return { ok: true, result: { problems: { vercel: { kind: 'sign-in' } } } }
      }
      const answer = answers[method]
      if (!answer) {
        return { ok: false, error: { code: 'runtime_error', message: method } }
      }
      try {
        return { ok: true, result: await answer() }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: { code: 'runtime_error', message } }
      }
    }
  })
  // The page stays warm between fixtures, so account-wide state is read again for each.
  withBotConnectorRuntime(window.api)

  void refreshBotLinear('local')
  void refreshBotGitHub('local')
}

export async function clickWhenShown(match: (button: HTMLElement) => boolean): Promise<void> {
  for (let tries = 0; tries < 60; tries++) {
    const button = [...document.querySelectorAll<HTMLElement>('button')].find(match)
    if (button) {
      button.click()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
export const named = (name: string) => (button: HTMLElement) => button.textContent?.trim() === name

/** The Connectors tab, at a sidebar `width` when given. */
export const Panel = ({ bot, width }: { bot: Bot; width?: number }): React.JSX.Element => (
  <ConfirmationDialogProvider>
    {/* Its own container, as BotConnectorsPanel draws it. */}
    <div
      style={{ width }}
      className="@container/connectors-panel bg-sidebar px-2 py-3 text-sidebar-foreground"
    >
      <BotConnectorsSection bot={bot} />
    </div>
  </ConfirmationDialogProvider>
)

export const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export const botsChanged = () => emitBotsChangedWindowEvent('local')
