// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { Bot } from '../../../../../shared/bot-types'
import { useAppStore } from '@/store'
import { ORCA_SIGNED_OUT } from '../orca-sign-in.test-fixture'
import { BotWebhooksCard } from './BotWebhooksCard'
import { notifyWebhooksChanged } from './use-webhook-data'
import { setWebhookHostTransportForTests } from './webhook-host-client'
import { webhookCallsFixture, webhookSummaryFixture } from './webhook-summary.test-fixture'

const bot: Bot = {
  id: 'bot-1',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'fw-1',
  agent: 'codex',
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

// Call times only need to be in order.
const NOW = 1_800_000_000_000
const confirm = vi.fn()
const host = vi.fn()

function renderRow(answer: (method: string, params: unknown) => unknown): void {
  host
    .mockReset()
    .mockImplementation(async (_target, method: string, params: unknown) => answer(method, params))
  setWebhookHostTransportForTests(host)
  Object.assign(window, { api: { ui: { writeSecretClipboardText: vi.fn() } } })
  render(
    <ConfirmationDialogContext.Provider value={confirm}>
      <BotWebhooksCard bot={bot} />
    </ConfirmationDialogContext.Provider>
  )
}

async function openRow(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Webhooks' }))
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  confirm.mockReset()
  setWebhookHostTransportForTests(null)
  Reflect.deleteProperty(window, 'api')
})

describe('BotWebhooksCard', () => {
  it('hides Webhooks for an unsupported host and backs off before reading it again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderRow(() => {
      throw new RuntimeRpcCallError({
        id: '1',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'r' }
      })
    })
    await waitFor(() =>
      expect(host).toHaveBeenCalledWith(expect.anything(), 'webhooks.list', { botId: 'bot-1' })
    )
    expect(screen.queryByText('Webhooks')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(host).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    expect(host).toHaveBeenCalledTimes(2)
  })

  it('lists the first hook after it appears, with its destination, filters and recent calls', async () => {
    const summary = webhookSummaryFixture({
      adapter: 'sentry',
      resultsTo: { channel: '#alerts' },
      filters: { where: [{ path: 'level', op: 'in', values: ['error', 'fatal'] }], pick: ['title'] }
    })
    let hooks: (typeof summary)[] = []
    await act(async () => {
      renderRow((method) =>
        method === 'webhooks.list' ? { hooks } : { calls: webhookCallsFixture(NOW) }
      )
    })
    expect(host).toHaveBeenCalledWith(expect.anything(), 'webhooks.list', { botId: 'bot-1' })
    expect(screen.queryByRole('button', { name: 'Webhooks' })).toBeNull()

    hooks = [summary]
    act(() => notifyWebhooksChanged())
    // A lone hook opens on its fields.
    expect(await screen.findByText('“Investigate Sentry alert” · results to #alerts')).toBeTruthy()
    expect(screen.getByText('Sentry signature, with your Sentry secret')).toBeTruthy()
    expect(screen.getByText('level')).toBeTruthy()
    expect(await screen.findByText('Refused ×6')).toBeTruthy()
    expect(screen.getByText('run #12 in #alerts')).toBeTruthy()
    // The Settings row offers the URL only, as approved; the card also offers the header key.
    expect(screen.queryByText('Header key')).toBeNull()
    expect(screen.getByText('wrong key or signature · nothing kept')).toBeTruthy()
    // Nothing secret is on screen.
    expect(document.body.textContent).not.toContain('orcawh_')
  })

  it('generates or pastes a signing secret from the Webhooks row', async () => {
    renderRow((method) =>
      method === 'webhooks.list'
        ? { hooks: [webhookSummaryFixture()] }
        : method === 'webhooks.calls'
          ? { calls: [] }
          : {}
    )
    const secretWrites = () =>
      host.mock.calls.filter(([, method]) => method === 'webhooks.secret').map((call) => call[2])
    const openSecret = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Add a signature…' }))
    await openRow()
    openSecret()
    expect(screen.getByRole('radio', { name: 'Orca makes one' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(screen.queryByLabelText('Standard Webhooks secret')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Generate secret' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(secretWrites()).toEqual([
      expect.objectContaining({ adapter: 'standard', generate: true })
    ])
    expect(secretWrites()[0]).not.toHaveProperty('secret')

    openSecret()
    fireEvent.click(screen.getByRole('radio', { name: 'Paste the sender’s' }))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Standard Webhooks secret'), {
      target: { value: '  pasted-test-value  ' }
    })
    fireEvent.click(save)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(secretWrites()[1]).toMatchObject({ adapter: 'standard', secret: 'pasted-test-value' })
    expect(secretWrites()[1]).not.toHaveProperty('generate')

    openSecret()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Sender' }), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'GitHub' }))
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate secret' })).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Sender' }), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Sentry' }))
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByLabelText('Sentry secret')).toBeTruthy()
  })

  it('rotates with the old key stopped only when the owner picks it', async () => {
    renderRow((method) =>
      method === 'webhooks.list'
        ? { hooks: [webhookSummaryFixture({ pendingCalls: 3 })] }
        : method === 'webhooks.calls'
          ? { calls: [] }
          : {}
    )
    await openRow()
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate key…' }))
    expect(
      screen.getByText('For a leaked key. 3 waiting calls it let in are cancelled.')
    ).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Stop the old key now'))
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }))
    await waitFor(() =>
      expect(host).toHaveBeenCalledWith(
        expect.anything(),
        'webhooks.rotate',
        expect.objectContaining({ hookId: 'wh_7Kx2pQ9mT4vB8nLc', stopNow: true })
      )
    )
    // The next opening starts on keeping the old key again.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rotate key' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key…' }))
    expect(
      screen.getByLabelText('Keep the old key working for 24 hours').getAttribute('aria-checked')
    ).toBe('true')
  })

  it('deletes only after the confirm', async () => {
    renderRow((method) =>
      method === 'webhooks.list'
        ? { hooks: [webhookSummaryFixture()] }
        : method === 'webhooks.calls'
          ? { calls: [] }
          : {}
    )
    confirm.mockResolvedValueOnce(false)
    await openRow()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete hook…' }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(host).not.toHaveBeenCalledWith(expect.anything(), 'webhooks.delete', expect.anything())
    expect(confirm.mock.calls[0][0]).toMatchObject({ confirmVariant: 'destructive' })
    confirm.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'Delete hook…' }))
    await waitFor(() =>
      expect(host).toHaveBeenCalledWith(expect.anything(), 'webhooks.delete', {
        hookId: 'wh_7Kx2pQ9mT4vB8nLc'
      })
    )
  })

  it('keeps the hooks listed when a refresh fails, with the reason above them', async () => {
    let failing = false
    renderRow((method) => {
      if (failing) {
        throw new RuntimeRpcCallError({
          id: '1',
          ok: false,
          error: { code: 'host_offline', message: 'offline' },
          _meta: { runtimeId: 'r' }
        })
      }
      return method === 'webhooks.list' ? { hooks: [webhookSummaryFixture()] } : { calls: [] }
    })
    await openRow()
    await screen.findByText('Investigate Sentry alert')
    failing = true
    act(() => notifyWebhooksChanged())
    expect(await screen.findByText('Scout’s computer is offline')).toBeTruthy()
    expect(screen.getByText('Investigate Sentry alert')).toBeTruthy()
  })

  it('reads hooks as paused while signed out, never as unavailable', async () => {
    const initial = useAppStore.getState()
    let failing = false
    renderRow((method) => {
      if (failing) {
        throw new RuntimeRpcCallError({
          id: '1',
          ok: false,
          error: { code: 'webhooks_unavailable', message: 'signed out' },
          _meta: { runtimeId: 'r' }
        })
      }
      return method === 'webhooks.list' ? { hooks: [webhookSummaryFixture()] } : { calls: [] }
    })
    try {
      await openRow()
      await screen.findByText('Investigate Sentry alert')
      failing = true
      act(() => {
        useAppStore.setState({ orcaProfileAuthStatus: ORCA_SIGNED_OUT })
        notifyWebhooksChanged()
      })
      expect(await screen.findByText('Paused while signed out of Orca.')).toBeTruthy()
      expect(screen.getByText('Investigate Sentry alert · paused while signed out')).toBeTruthy()
      expect(screen.getByText('Needs sign-in')).toBeTruthy()
      expect(screen.queryByText('Webhooks aren’t available right now.')).toBeNull()
    } finally {
      useAppStore.setState(initial, true)
    }
  })

  it('reads an offline computer as a plain line and keeps the key actions off', async () => {
    renderRow((method) =>
      method === 'webhooks.list'
        ? { hooks: [webhookSummaryFixture({ host: 'offline' })] }
        : { calls: [] }
    )
    await openRow()
    expect(await screen.findByText('Scout’s computer is offline')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy URL' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Rotate key…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Delete hook…' }).hasAttribute('disabled')).toBe(true)
  })
})
