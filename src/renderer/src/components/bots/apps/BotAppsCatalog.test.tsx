// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), openUrl: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))

import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AddConnectorDialog } from '../AddConnectorDialog'
import { resetComposioClientForTest } from '../composio/composio-client'
import { retryBotToolCheck } from '../bot-tools-revision'
import { COMPOSIO_PAGES } from '../../../../../shared/composio/composio-apps'

const bot: Bot = {
  id: 'bot-1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
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

type Answers = Record<string, (params: Record<string, unknown>) => unknown>
function answer(answers: Answers): void {
  mocks.rpc
    .mockReset()
    .mockImplementation(
      async (_target: unknown, method: string, params: Record<string, unknown>) => {
        const reply = answers[method]
        if (!reply) {
          throw new Error(method)
        }
        return reply(params)
      }
    )
}

const tools = {
  'bots.tools.list': () => ({ own: [], inherited: [] }),
  'bots.tools.context': () => ({ folder: '/bots/reviewer', platform: 'darwin', agent: 'claude' }),
  'bots.tools.signInStatus': () => ({ status: 'pending' })
}

/** A tool Orca signs in to, as the host answers a new one: signed out. */
const signInTool = (name: string) => ({
  name,
  detail: '',
  remote: false,
  signIn: { state: 'signed-out' }
})
const orcaConnect = () => ({
  attemptId: 'attempt-1',
  authorizationOrigin: 'https://sign-in.example'
})

const declineConfirm = async (): Promise<boolean> => false

function open(): void {
  render(
    <ConfirmationDialogContext.Provider value={declineConfirm}>
      <TooltipProvider>
        <AddConnectorDialog bot={bot} open onOpenChange={vi.fn()} onAdd={vi.fn()} />
      </TooltipProvider>
    </ConfirmationDialogContext.Provider>
  )
}

const calls = (method: string) => mocks.rpc.mock.calls.filter(([, name]) => name === method)

beforeEach(() => {
  const off = { state: vi.fn().mockResolvedValue({ ok: false, error: 'off' }) }
  Object.assign(window, {
    api: withBotConnectorRuntime({
      botLinear: off,
      botGitHub: off,
      shell: { openUrl: mocks.openUrl }
    })
  })
  mocks.openUrl.mockReset()
})

afterEach(() => {
  cleanup()
  resetComposioClientForTest()
  Reflect.deleteProperty(window, 'api')
})

describe('Add to <bot>', () => {
  it('signs in to an address that needs it from this computer, with no paste-back', async () => {
    answer({
      ...tools,
      'bots.tools.add': () => ({ tool: signInTool('pagerduty') }),
      // Orca opened the browser itself; the sign-in is under way.
      'bots.tools.connect': orcaConnect
    })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add by URL' }))
    fireEvent.change(await screen.findByLabelText('Server URL or start command'), {
      target: { value: 'https://mcp.pagerduty.com/mcp' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(await screen.findByText('Finish in your browser')).toBeTruthy()
    expect(screen.queryByText(/is on Reviewer/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Signing in on another computer?' })).toBeNull()
  })

  it('routes a curated Composio app found by search by Composio’s own sign-in record', async () => {
    answer({
      'bots.composio.status': () => ({ key: 'ok', added: true, limit: null }),
      'bots.composio.connections': () => ({ connections: [], pending: [] }),
      'bots.composio.apps': () => ({
        apps: [{ slug: 'jira', name: 'Jira', description: 'Issues', logo: null, signIn: 'own' }],
        nextCursor: null
      }),
      'bots.composio.app': () => ({
        slug: 'jira',
        name: 'Jira',
        description: 'Issues',
        logo: null,
        signIn: 'own'
      }),
      'bots.composio.connect': () => ({ url: 'https://composio.example/connect' })
    })
    open()
    await waitFor(() => expect(calls('bots.composio.connections')).not.toHaveLength(0))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search apps' }), {
      target: { value: 'jira' }
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Add Jira' }))

    // Jira needs the owner's own developer app at Composio, so Add opens its auth configs.
    await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith(COMPOSIO_PAGES.authConfigs))
    expect(calls('bots.composio.connect')).toHaveLength(0)
  })

  it('lists an MCP catalog entry in its category, and Add adds it by URL and signs in', async () => {
    answer({
      ...tools,
      'bots.tools.add': () => ({ tool: signInTool('sentry') }),
      'bots.tools.connect': orcaConnect
    })
    open()
    fireEvent.click(screen.getByRole('button', { name: /^Monitoring/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add Sentry' }))

    expect(await screen.findByText('Finish in your browser')).toBeTruthy()
    expect(calls('bots.tools.add')[0]?.[2]).toEqual({
      botId: 'bot-1',
      source: 'https://mcp.sentry.dev/mcp',
      name: 'sentry'
    })
    expect(screen.getByText('Sign in to Sentry and allow access.')).toBeTruthy()
  })

  it('retries a failed MCP add by adding again, not by signing in to a tool that was never added', async () => {
    let adds = 0
    answer({
      ...tools,
      'bots.tools.add': () => {
        adds += 1
        if (adds === 1) {
          throw new Error('Could not write the bot’s tools.')
        }
        return { tool: signInTool('sentry') }
      },
      'bots.tools.connect': orcaConnect
    })
    open()
    fireEvent.click(screen.getByRole('button', { name: /^Monitoring/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add Sentry' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Finish in your browser')).toBeTruthy()
    expect(calls('bots.tools.add')).toHaveLength(2)
    expect(calls('bots.tools.connect')).toHaveLength(1)
  })

  it('retries a failed MCP sign-in by signing in again to the tool it already added', async () => {
    let connects = 0
    let added = false
    answer({
      ...tools,
      'bots.tools.list': () => ({
        own: added ? [signInTool('sentry')] : [],
        inherited: []
      }),
      'bots.tools.add': () => {
        added = true
        return { tool: signInTool('sentry') }
      },
      'bots.tools.connect': () => {
        connects += 1
        if (connects === 1) {
          throw new Error('Sentry refused the sign-in.')
        }
        return orcaConnect()
      }
    })
    open()
    fireEvent.click(screen.getByRole('button', { name: /^Monitoring/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add Sentry' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Finish in your browser')).toBeTruthy()
    expect(calls('bots.tools.add')).toHaveLength(1)
    expect(calls('bots.tools.connect')).toHaveLength(2)
  })

  it('keeps an added app in All apps and its category, with Manage in place of Add', async () => {
    // A fresh read, past one an earlier test left for this bot.
    retryBotToolCheck()
    answer({
      ...tools,
      'bots.tools.list': () => ({
        own: [
          { name: 'sentry', detail: 'https://mcp.sentry.dev/mcp', remote: true },
          { name: 'metrics', detail: 'node metrics.js', remote: false }
        ],
        inherited: []
      })
    })
    open()
    expect(await screen.findByRole('button', { name: 'Manage Sentry' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add Sentry' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Monitoring/ }))
    expect(await screen.findByRole('button', { name: 'Manage Sentry' })).toBeTruthy()
    // Which apps it has comes from its tools alone: no check starts its servers.
    expect(calls('bots.tools.problems')).toHaveLength(0)
  })
})
