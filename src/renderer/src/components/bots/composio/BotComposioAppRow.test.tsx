// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { ComposioConnection } from '../../../../../shared/composio/composio-apps'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), openUrl: vi.fn(), confirm: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))

import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import { BotComposioAppRow } from './BotComposioAppRow'
import { ComposioSignInWait } from './ComposioSignInWait'
import { resetComposioClientForTest, useComposioBot } from './composio-client'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test bot with the fields the rows read.
const bot = {
  id: 'bot-1',
  hostId: 'local',
  name: 'Atlas',
  agent: 'claude',
  members: []
} as unknown as Bot
const jira: ComposioConnection = {
  id: 'ca_1',
  app: 'jira',
  name: 'Jira',
  status: 'active',
  label: 'dana@acme.com'
}
const notion = { slug: 'notion', name: 'Notion', line: 'Pages' }

type Answers = Record<string, () => unknown>
function answer(answers: Answers): void {
  mocks.rpc.mockReset().mockImplementation(async (_target: unknown, method: string) => {
    const reply = answers[method]
    if (!reply) {
      throw new Error(method)
    }
    return reply()
  })
}

const botsChanged = () => act(() => void emitBotsChangedWindowEvent('local'))

beforeEach(() => {
  Object.assign(window, { api: { shell: { openUrl: mocks.openUrl } } })
})
afterEach(() => {
  cleanup()
  resetComposioClientForTest()
})

describe('a Composio app among a bot’s connectors', () => {
  it('offers only what Composio supports: sign in again and disconnect, no people of its own', async () => {
    answer({})
    render(
      <ConfirmationDialogContext.Provider value={mocks.confirm}>
        <BotComposioAppRow bot={bot} connection={jira} problem={null} />
      </ConfirmationDialogContext.Provider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Jira' }))
    expect(screen.queryByText(/Who can ask/)).toBeNull()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Jira actions' }), {
      button: 0,
      ctrlKey: false
    })
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent)
    expect(items).toEqual(['Sign in again', 'Disconnect Jira'])
  })
})

describe('the bot’s Composio sign-ins when Composio fails', () => {
  function Probe(): React.JSX.Element {
    const view = useComposioBot(bot)
    return (
      <p>
        {view.status?.key ?? 'unread'}:{' '}
        {view.connections?.connections.map((entry) => entry.app).join(',') ?? 'none'}
      </p>
    )
  }

  it('keeps the last sign-ins read when the key is refused or the read fails', async () => {
    let key = 'ok'
    let failRead = false
    answer({
      'bots.composio.status': () => ({ key, added: true, limit: null }),
      'bots.composio.connections': () => {
        if (failRead) {
          throw new Error('down')
        }
        return { connections: [jira], pending: [] }
      }
    })
    render(<Probe />)
    expect(await screen.findByText('ok: jira')).toBeTruthy()
    key = 'rejected'
    botsChanged()
    expect(await screen.findByText('rejected: jira')).toBeTruthy()
    key = 'ok'
    failRead = true
    botsChanged()
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(), 'bots.composio.connections', {
        botId: 'bot-1'
      })
    )
    expect(await screen.findByText('ok: jira')).toBeTruthy()
  })
})

describe('signing in to a Composio app from Add a connector', () => {
  it('offers a retry after an unfinished sign-in or a failed Connect', async () => {
    let pending = true
    answer({
      'bots.composio.status': () => ({ key: 'ok', added: true, limit: null }),
      'bots.composio.connections': () => ({
        connections: [],
        pending: pending ? [{ app: 'notion', url: 'https://x', startedAt: 1 }] : []
      })
    })
    const onRetry = vi.fn()
    const props = { bot, app: notion, onDone: vi.fn(), onRetry, onClose: vi.fn() }
    const { rerender } = render(<ComposioSignInWait key="first" {...props} connectError={null} />)
    expect(await screen.findByText('Finish in your browser')).toBeTruthy()
    // The host drops its wait after the attempt ends.
    pending = false
    botsChanged()
    expect(await screen.findByText('Couldn’t sign in to Notion')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()

    rerender(<ComposioSignInWait key="retry" {...props} connectError="Composio refused the link" />)
    expect(screen.getByText('Composio refused the link')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(2)
  })
})
