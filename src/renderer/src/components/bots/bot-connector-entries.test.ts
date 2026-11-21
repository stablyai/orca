import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { ComposioConnection } from '../../../../shared/composio/composio-apps'
import { botConnectorEntries, type BotConnectorSources } from './bot-connector-entries'

// The pure list only; the stores' modules would otherwise start reading on import.

const bot: Bot = {
  id: 'bot-1',
  name: 'CoS',
  hostId: 'local',
  folder: 'cos',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: { appId: 'A1', teamId: 'T1' },
  linear: null,
  linearWorkspaces: [{ workspaceId: 'org-1', workspaceName: 'Acme' }],
  github: null,
  google: true,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const slackOnComposio: ComposioConnection = {
  id: 'ca-slack',
  app: 'slack',
  name: 'Slack',
  status: 'active',
  label: 'dana@acme.dev'
}

function sources(overrides: Partial<BotConnectorSources> = {}): BotConnectorSources {
  return {
    slack: {
      status: 'ready',
      slack: {
        state: 'installed',
        teamId: 'T1',
        teamName: 'Acme',
        appId: 'A1',
        botUserId: 'UB',
        installerUserId: 'U1'
      }
    },
    linear: {
      status: 'ready',
      linear: {
        installUrl: 'https://connector.example/linear',
        workspaces: [
          {
            workspaceId: 'org-1',
            name: 'Acme',
            urlKey: 'acme',
            installed: true,
            userId: 'L1',
            userName: 'Dana',
            defaultBotId: null
          }
        ]
      }
    },
    github: { status: 'off' },
    google: {
      status: 'ready',
      google: {
        client: null,
        accounts: [{ email: 'dana@acme.dev', status: 'connected', services: [], connectedAt: 1 }],
        bots: []
      }
    },
    composio: {
      status: { key: 'ok', limit: null, added: true },
      connections: { connections: [slackOnComposio], pending: [] },
      error: null
    },
    tools: { status: 'loading' },
    ...overrides
  }
}

const kinds = (entries: ReturnType<typeof botConnectorEntries>) => entries.map((e) => e.key)
const needingOwner = (entries: ReturnType<typeof botConnectorEntries>) =>
  entries.filter((entry) => entry.needsOwner).map((entry) => entry.key)

describe('botConnectorEntries', () => {
  it('lists both connections to Slack and omits a sign-in still under way', () => {
    const entries = botConnectorEntries(
      bot,
      sources({
        composio: {
          status: { key: 'ok', limit: null, added: true },
          connections: {
            connections: [
              slackOnComposio,
              { ...slackOnComposio, id: 'ca-pending', status: 'pending' }
            ],
            pending: []
          },
          error: null
        }
      })
    )
    expect(kinds(entries)).toEqual([
      'slack:T1',
      'linear:org-1',
      'google',
      'webhooks',
      'composio:ca-slack'
    ])
    expect(needingOwner(entries)).toEqual([])
  })

  it('counts each connector that needs the owner, for the tab badge', () => {
    const entries = botConnectorEntries(
      bot,
      sources({
        linear: {
          status: 'ready',
          linear: { installUrl: 'https://connector.example/linear', workspaces: [] }
        },
        composio: {
          status: { key: 'ok', limit: null, added: true },
          connections: {
            connections: [{ ...slackOnComposio, status: 'expired' }],
            pending: []
          },
          error: null
        }
      })
    )
    expect(needingOwner(entries)).toEqual(['linear:org-1', 'composio:ca-slack'])
  })

  it('keeps known apps listed when the key is refused, each needing the owner', () => {
    const entries = botConnectorEntries(
      bot,
      sources({
        composio: {
          status: { key: 'rejected', limit: null, added: true },
          connections: { connections: [slackOnComposio], pending: [] },
          error: null
        }
      })
    )
    expect(entries.find((entry) => entry.key === 'composio:ca-slack')).toMatchObject({
      problem: 'key',
      needsOwner: true
    })
  })

  it('shows a recovery row after a failed read only for a bot using Composio', () => {
    const unread = botConnectorEntries(
      { ...bot, slack: null, linearWorkspaces: [], google: false },
      sources({
        composio: {
          status: { key: 'ok', limit: null, added: true },
          connections: null,
          error: 'Composio didn’t answer'
        }
      })
    )
    expect(unread.map((entry) => [entry.key, entry.needsOwner])).toEqual([
      ['webhooks', false],
      ['composio', true]
    ])
    expect(unread.at(-1)).toMatchObject({ kind: 'composio-problem', problem: 'unread' })

    const entries = botConnectorEntries(
      bot,
      sources({
        composio: {
          status: { key: 'rejected', limit: null, added: false },
          connections: null,
          error: null
        }
      })
    )
    expect(kinds(entries).filter((key) => key.startsWith('composio'))).toEqual([])
  })

  it('lists the apps the bot has as tools, Add to <bot>’s and by URL, not commands or Composio', () => {
    const entries = botConnectorEntries(
      bot,
      sources({
        tools: {
          status: 'ready',
          tools: {
            agent: 'codex',
            own: [
              { name: 'vercel', detail: 'https://mcp.vercel.com', remote: true },
              { name: 'docs', detail: 'https://docs.example.com/mcp', remote: true },
              { name: 'metrics', detail: 'node metrics-mcp/index.js', remote: false },
              {
                name: 'composio',
                detail: 'https://backend.composio.dev/tool_router/s1/mcp',
                remote: true
              }
            ],
            inherited: []
          },
          problems: { vercel: { kind: 'sign-in' }, docs: { kind: 'unconfirmed' } }
        }
      })
    )
    const apps = entries.filter((entry) => entry.kind === 'app')
    expect(apps.map((entry) => [entry.key, entry.app?.name ?? null, entry.needsOwner])).toEqual([
      ['app:vercel', 'Vercel', true],
      ['app:docs', null, false]
    ])
  })
})
