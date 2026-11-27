import { useSyncExternalStore } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Button } from '@/components/ui/button'
import {
  publishBots,
  readBots,
  stampBotHost,
  subscribeToBotChanges
} from '@/lib/bot-catalog-snapshot'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { AddConnectorButton } from '../AddConnectorButton'
import { GitHubInstallMount } from '../github/GitHubInstallMount'

const emptyBot: Bot = {
  id: 'field-notes-empty',
  name: 'Field Notes',
  hostId: 'local',
  folder: 'field-notes',
  folderWorkspaceId: 'fw-field-notes',
  agent: 'pi',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

const connectedBot: Bot = { ...emptyBot, id: 'field-notes-connected', agent: 'claude', github: {} }
const expandedBot: Bot = {
  ...connectedBot,
  id: 'field-notes-expanded',
  name: 'Field Notes for the Expedition Planning and Records Team',
  github: { removedInstallationIds: ['314', '271'] }
}
const remoteHost: PublicKnownRuntimeEnvironment = {
  id: 'fixture-server',
  name: 'Field Kit',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: 'fixture-server'
}
const remoteStatus = createCompatibleRuntimeStatusResponse(remoteHost.id)

function stubHost(bot: Bot): void {
  let currentBot = bot
  publishBots([bot], undefined, bot.hostId)
  const connected = bot.github !== null
  const expanded = bot.id === expandedBot.id
  const tools = connected ? ['field-maps'] : []
  if (expanded) {
    tools.push('expedition-ledger')
  }
  const composioApps = [
    {
      slug: 'notion',
      name: 'Notion',
      description: 'Pages and databases',
      logo: null,
      signIn: 'composio'
    },
    {
      slug: 'github-labs',
      name: 'GitHub Labs',
      description: 'Repository reports',
      logo: null,
      signIn: 'composio'
    }
  ]
  const results: Record<string, unknown> = {
    'bots.groups.list': { groups: [] },
    'bots.tools.list': {
      agent: bot.agent,
      own: tools.map((name) => ({ name, detail: `https://${name}.example/mcp`, remote: true })),
      inherited: []
    },
    'bots.tools.context': { folder: '/bots/field-notes', platform: 'darwin', agent: bot.agent },
    'bots.tools.add': {
      tool: {
        name: 'vercel',
        detail: 'https://vercel.example/mcp',
        remote: true,
        signIn: { state: 'signed-out' }
      }
    },
    'bots.tools.connect': {
      attemptId: 'fixture-attempt',
      authorizationOrigin: 'https://signin.example'
    },
    'bots.tools.signInStatus': { status: 'pending' },
    'bots.composio.status': { key: connected ? 'ok' : 'none', added: connected, limit: null },
    'bots.composio.connections': {
      connections: connected
        ? [
            {
              id: 'fixture-connection',
              app: 'notion',
              name: 'Notion',
              status: 'active',
              label: null
            }
          ]
        : [],
      pending: []
    },
    'bots.linear.state': {
      ok: true,
      value: { installUrl: 'https://linear.example/install', workspaces: [] }
    },
    'bots.github.state': {
      ok: true,
      value: {
        installUrl: 'https://github.example/install',
        account: null,
        installations: expanded
          ? [
              { installationId: '314', accountLogin: 'field-notes-labs', repositories: null },
              { installationId: '271', accountLogin: 'field-notes-studio', repositories: null }
            ]
          : [],
        defaultBotId: null
      }
    },
    'webhooks.list': { hooks: [] }
  }
  const call = async ({
    method,
    params
  }: {
    method: string
    params?: { query?: string; updates?: Pick<Bot, 'github'> }
  }) => {
    if (method === 'status.get') {
      return remoteStatus
    }
    if (method === 'bots.composio.apps') {
      const query = params?.query?.toLowerCase() ?? ''
      const apps = composioApps.filter((app) => app.name.toLowerCase().includes(query))
      return { ok: true, result: { apps, nextCursor: null } }
    }
    if (method === 'bots.list') {
      return { ok: true, result: { bots: [currentBot] } }
    }
    if (method === 'bots.update' && params?.updates) {
      currentBot = { ...currentBot, ...params.updates }
      publishBots([currentBot], undefined, bot.hostId)
      return { ok: true, result: { bot: currentBot } }
    }
    return method in results
      ? { ok: true, result: results[method] }
      : { ok: false, error: { code: 'runtime_error', message: method } }
  }
  Reflect.set(window.api, 'runtime', { ...window.api.runtime, call })
  Reflect.set(window.api, 'runtimeEnvironments', { ...window.api.runtimeEnvironments, call })
}

function CatalogFixture({ bot }: { bot: Bot }): React.JSX.Element {
  const bots = useSyncExternalStore(subscribeToBotChanges, readBots)
  return (
    <ConfirmationDialogProvider>
      <AddConnectorButton
        bot={bots.find((entry) => entry.id === bot.id) ?? bot}
        trigger={(open) => (
          <Button data-fixture-open-catalog onClick={open}>
            Open catalog
          </Button>
        )}
      />
      <GitHubInstallMount />
    </ConfirmationDialogProvider>
  )
}

function catalogFixture(
  bot: Bot,
  width: number,
  store?: Parameters<typeof defineFixture>[0]['store']
) {
  return defineFixture({
    width,
    store,
    setup: () => stubHost(bot),
    render: () => <CatalogFixture bot={bot} />,
    interact: (frame) =>
      frame.querySelector<HTMLButtonElement>('[data-fixture-open-catalog]')?.click()
  })
}

const remoteBot = stampBotHost(`runtime:${remoteHost.id}`, {
  ...connectedBot,
  id: 'field-notes-remote'
})

export const empty = catalogFixture(emptyBot, 1280)
export const added = catalogFixture(connectedBot, 1280)
export const expanded = catalogFixture(expandedBot, 860)
export const remote = catalogFixture(remoteBot, 860, {
  runtimeEnvironments: [remoteHost],
  runtimeStatusByEnvironmentId: new Map([
    [remoteHost.id, { status: remoteStatus.result, checkedAt: 1 }]
  ])
})
