// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { i18n } from '@/i18n/i18n'
import zh from '@/i18n/locales/zh.json'

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

function open(): () => void {
  const dialog = (listed: Bot) => (
    <ConfirmationDialogContext.Provider value={declineConfirm}>
      <TooltipProvider>
        <AddConnectorDialog bot={listed} open onOpenChange={vi.fn()} onAdd={vi.fn()} />
      </TooltipProvider>
    </ConfirmationDialogContext.Provider>
  )
  const view = render(dialog(bot))
  return () => view.rerender(dialog({ ...bot }))
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
  vi.useRealTimers()
})

describe('Add to <bot>', () => {
  it('signs in to an address that needs it from this computer, with no paste-back', async () => {
    let signedIn = false
    answer({
      ...tools,
      'bots.tools.add': () => ({ tool: signInTool('pagerduty') }),
      // Orca opened the browser itself; the sign-in is under way.
      'bots.tools.connect': orcaConnect,
      'bots.tools.signInStatus': () => ({ status: signedIn ? 'done' : 'pending' })
    })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Add by URL' }))
    fireEvent.change(await screen.findByLabelText('Server URL or start command'), {
      target: { value: 'https://mcp.pagerduty.com/mcp' }
    })
    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })

    expect(screen.getByText('Finish in your browser')).toBeTruthy()
    expect(screen.queryByText(/is on Reviewer/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remote sign-in' })).toBeNull()

    signedIn = true
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(screen.queryByText('Finish in your browser')).toBeNull()
  })

  it('routes a curated Composio app found by search by Composio’s own sign-in record', async () => {
    answer({
      'bots.composio.status': () => ({ key: 'ok', added: true, limit: null }),
      'bots.composio.connections': () => ({ connections: [], pending: [] }),
      'bots.composio.apps': () => ({
        apps: [
          { slug: 'jira', name: 'Jira', description: 'Issues', logo: null, signIn: 'own' },
          { slug: 'jira-labs', name: 'Jira Labs', description: 'Labs', logo: null, signIn: 'own' }
        ],
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
    const rereadBot = open()
    await waitFor(() => expect(calls('bots.composio.connections')).not.toHaveLength(0))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search apps' }), {
      target: { value: 'jira' }
    })
    await screen.findByRole('button', { name: 'Add Jira Labs' })
    rereadBot()
    expect(screen.getByRole('button', { name: 'Add Jira Labs' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Add Jira' }))

    // Jira needs the owner's own developer app at Composio, so Add opens its auth configs.
    await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith(COMPOSIO_PAGES.authConfigs))
    expect(calls('bots.composio.connect')).toHaveLength(0)
  })

  it('adds an app with sites at the picked site’s server, under the app’s own name', async () => {
    answer({ ...tools, 'bots.tools.add': () => ({ tool: signInTool('datadog') }) })
    open()
    fireEvent.click(screen.getByRole('button', { name: /^Monitoring/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add Datadog' }))

    fireEvent.keyDown(await screen.findByRole('combobox', { name: 'Datadog site' }), {
      key: 'ArrowDown'
    })
    fireEvent.click(await screen.findByRole('option', { name: /^EU/ }))
    expect(calls('bots.tools.add')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(calls('bots.tools.add')).toHaveLength(1))
    expect(calls('bots.tools.add')[0]?.[2]).toEqual({
      botId: 'bot-1',
      source: 'https://mcp.datadoghq.eu/v1/mcp',
      name: 'datadog'
    })
  })

  it('on Try again, names the other site already added instead of signing in to it', async () => {
    let saved = false
    answer({
      ...tools,
      'bots.tools.list': () => ({
        own: saved
          ? [{ name: 'datadog', detail: 'https://mcp.datadoghq.com/v1/mcp', remote: true }]
          : [],
        inherited: []
      }),
      'bots.tools.add': () => {
        // Another window adds US1 while this one picks EU.
        saved = true
        throw new Error('A tool named datadog already exists.')
      }
    })
    open()
    fireEvent.click(screen.getByRole('button', { name: /^Monitoring/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add Datadog' }))
    fireEvent.keyDown(await screen.findByRole('combobox', { name: 'Datadog site' }), {
      key: 'ArrowDown'
    })
    fireEvent.click(await screen.findByRole('option', { name: /^EU/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Datadog is already on Reviewer')).toBeTruthy()
    expect(screen.getByText('It’s added at US1. Remove it in Manage to add another.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy()
    expect(calls('bots.tools.connect')).toHaveLength(0)
    expect(calls('bots.tools.add')).toHaveLength(1)
  })

  it('on Try again, names no place for a same-name tool the app’s template doesn’t make', async () => {
    let saved = false
    answer({
      ...tools,
      'bots.tools.list': () => ({
        own: saved
          ? [{ name: 'datadog', detail: 'npx dd-mcp --api-key=secret', remote: false }]
          : [],
        inherited: []
      }),
      'bots.tools.add': () => {
        saved = true
        throw new Error('A tool named datadog already exists.')
      }
    })
    open()
    fireEvent.click(screen.getByRole('button', { name: /^Monitoring/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add Datadog' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Remove it in Manage to add another.')).toBeTruthy()
    expect(screen.queryByText(/secret/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy()
    expect(calls('bots.tools.connect')).toHaveLength(0)
  })

  it('shows the site field and places in the user’s language, site codes as they are', async () => {
    i18n.addResourceBundle('zh', 'translation', zh)
    await i18n.changeLanguage('zh')
    try {
      answer(tools)
      open()
      fireEvent.click(screen.getByRole('button', { name: /^监控|^Monitoring/ }))
      fireEvent.click(await screen.findByRole('button', { name: /Datadog/ }))
      fireEvent.keyDown(await screen.findByRole('combobox', { name: 'Datadog 站点' }), {
        key: 'ArrowDown'
      })
      expect(await screen.findByRole('option', { name: 'EU · 欧洲' })).toBeTruthy()
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('adds GitLab at a typed self-managed host, refusing one that is not a host', async () => {
    answer({ ...tools, 'bots.tools.add': () => ({ tool: signInTool('gitlab') }) })
    open()
    fireEvent.click(screen.getByRole('button', { name: /^Coding/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add GitLab' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }))
    const field = screen.getByLabelText('GitLab address (optional)')
    fireEvent.change(field, { target: { value: 'gitlab acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(calls('bots.tools.add')).toHaveLength(0)

    fireEvent.change(field, { target: { value: 'https://GitLab.acme.dev/explore' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(calls('bots.tools.add')).toHaveLength(1))
    expect(calls('bots.tools.add')[0]?.[2]).toEqual({
      botId: 'bot-1',
      source: 'https://gitlab.acme.dev/api/v4/mcp',
      name: 'gitlab'
    })
  })

  it('retries an MCP app at the failed step without adding it twice', async () => {
    let added = false
    let adds = 0
    let connects = 0
    answer({
      ...tools,
      'bots.tools.list': () => ({
        own: added ? [{ ...signInTool('sentry'), detail: 'https://mcp.sentry.dev/mcp' }] : [],
        inherited: []
      }),
      'bots.tools.add': () => {
        adds += 1
        if (adds === 1) {
          throw new Error('Could not write the bot’s tools.')
        }
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

    const retryAdd = await screen.findByRole('button', { name: 'Try again' })
    expect(calls('bots.tools.connect')).toHaveLength(0)
    fireEvent.click(retryAdd)

    await waitFor(() => expect(calls('bots.tools.connect')).toHaveLength(1))
    const retrySignIn = await screen.findByRole('button', { name: 'Try again' })
    expect(calls('bots.tools.add')).toHaveLength(2)
    expect(calls('bots.tools.add').at(-1)?.[2]).toEqual({
      botId: 'bot-1',
      source: 'https://mcp.sentry.dev/mcp',
      name: 'sentry'
    })
    fireEvent.click(retrySignIn)

    expect(await screen.findByText('Finish in your browser')).toBeTruthy()
    expect(screen.getByText('Sign in to Sentry and allow access.')).toBeTruthy()
    expect(calls('bots.tools.connect')).toHaveLength(2)
    expect(calls('bots.tools.add')).toHaveLength(2)
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
  it('tags an app added at another site or host, and not one at its default', async () => {
    retryBotToolCheck()
    answer({
      ...tools,
      'bots.tools.list': () => ({
        own: [
          { name: 'datadog', detail: 'https://mcp.datadoghq.eu/v1/mcp', remote: true },
          { name: 'gitlab', detail: 'https://gitlab.acme.dev/api/v4/mcp', remote: true },
          { name: 'sentry', detail: 'https://mcp.sentry.dev/mcp', remote: true }
        ],
        inherited: []
      })
    })
    open()
    const row = async (name: string) =>
      (await screen.findByRole('button', { name: `Manage ${name}` })).closest('li')?.textContent
    expect(await row('Datadog')).toContain('DatadogEU')
    expect(await row('GitLab')).toContain('GitLabgitlab.acme.dev')
    expect(await row('Sentry')).toMatch(/^SentryLook/)
  })
})
