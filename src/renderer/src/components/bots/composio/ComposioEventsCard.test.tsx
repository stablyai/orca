// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), bots: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/bot-catalog', () => ({
  openBotHomeTab: vi.fn(),
  useBots: () => [{ hostId: 'local', id: 'bot-1', name: 'Atlas' }]
}))

import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import { webhookSummaryFixture } from '../webhooks/webhook-summary.test-fixture'
import { ComposioSetupChatCard } from './ComposioSetupChatCard'

const card = {
  botId: 'bot-1',
  card: 'events' as const,
  hookId: 'wh_1',
  trigger: { slug: 'OUTLOOK_MESSAGE_TRIGGER', name: 'New Outlook Message' }
}

type Ingress = { hookId: string; signed: boolean }

/** The host's events status; `ingress` is the project's events hook, if it has one. */
function hostSays(target: string, on = false, ingress?: Ingress) {
  mocks.rpc.mockReset().mockImplementation(async (_target: unknown, method: string, params) => {
    if (method === 'bots.composio.eventsStatus') {
      return { target, on, ...(ingress ? { ingress } : {}) }
    }
    if (method === 'bots.composio.eventsByHand') {
      ingress ??= { hookId: 'wh_ingress', signed: false }
      return { hookId: ingress.hookId }
    }
    if (method === 'bots.composio.setUpEvents') {
      target = 'ours'
      on = true
      ingress = ingress && { ...ingress, signed: true }
      return { done: true }
    }
    if (method === 'webhooks.card') {
      return webhookSummaryFixture({ hookId: params.hookId, automationName: 'Composio events' })
    }
    return {}
  })
}

describe('the Composio events card', () => {
  beforeEach(() => {
    Object.assign(window, { api: { shell: { openUrl: vi.fn() } } })
  })
  afterEach(cleanup)

  it('sets it all up in one click when the project sends its events nowhere', async () => {
    hostSays('none')
    render(<ComposioSetupChatCard card={card} fallback="fallback" />)
    expect(screen.getByText('Have Composio call Atlas on New Outlook Message')).toBeTruthy()
    const setUp = await screen.findByRole('button', { name: 'Set it up' })
    // Disabled until the host's first answer, so a click before then would do nothing.
    await waitFor(() => expect(setUp).toHaveProperty('disabled', false))
    fireEvent.click(setUp)
    expect(await screen.findByText('✓ Set up')).toBeTruthy()
    expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(), 'bots.composio.setUpEvents', {
      botId: 'bot-1',
      hookId: 'wh_1',
      trigger: 'OUTLOOK_MESSAGE_TRIGGER'
    })
  })

  it('asks before replacing where the project sends its events', async () => {
    hostSays('other')
    render(<ComposioSetupChatCard card={card} fallback="fallback" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Replace and set up' }))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        expect.anything(),
        'bots.composio.setUpEvents',
        expect.objectContaining({ replace: true })
      )
    )
  })

  it('by hand: the steps for the project’s events hook, kept on a reload, and Done finishes on the hook they showed', async () => {
    hostSays('none')
    const first = render(<ComposioSetupChatCard card={card} fallback="fallback" />)
    fireEvent.click(await screen.findByRole('button', { name: 'I’ll do it in Composio' }))
    expect(await screen.findByText('Doing it in Composio')).toBeTruthy()
    expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(), 'bots.composio.eventsByHand', {
      botId: 'bot-1',
      hookId: 'wh_1'
    })
    first.unmount()

    render(<ComposioSetupChatCard card={card} fallback="fallback" />)
    expect(await screen.findByRole('button', { name: 'Open Composio' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add signing secret…' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('✓ Set up')).toBeTruthy()
    expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(), 'bots.composio.setUpEvents', {
      botId: 'bot-1',
      hookId: 'wh_1',
      trigger: 'OUTLOOK_MESSAGE_TRIGGER',
      byHand: 'wh_ingress'
    })
  })

  it('by hand: the steps follow the current project’s hook after a key change, never the old one', async () => {
    hostSays('none')
    render(<ComposioSetupChatCard card={card} fallback="fallback" />)
    fireEvent.click(await screen.findByRole('button', { name: 'I’ll do it in Composio' }))
    expect(await screen.findByRole('button', { name: 'Open Composio' })).toBeTruthy()
    // Another project's key, with its own events hook.
    hostSays('other', false, { hookId: 'wh_b', signed: true })
    act(() => emitBotsChangedWindowEvent('local'))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(), 'webhooks.card', { hookId: 'wh_b' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        expect.anything(),
        'bots.composio.setUpEvents',
        expect.objectContaining({ byHand: 'wh_b' })
      )
    )
  })

  it('by hand: a project whose events hook is already signed still gets the steps', async () => {
    for (const target of ['other', 'ours']) {
      hostSays(target, false, { hookId: 'wh_signed', signed: true })
      const shown = render(<ComposioSetupChatCard card={card} fallback="fallback" />)
      const setUp = target === 'other' ? 'Replace and set up' : 'Set it up'
      await waitFor(() =>
        expect(screen.getByRole('button', { name: setUp }).hasAttribute('disabled')).toBe(false)
      )
      fireEvent.click(screen.getByRole('button', { name: 'I’ll do it in Composio' }))
      expect(await screen.findByRole('button', { name: 'Open Composio' })).toBeTruthy()
      shown.unmount()
    }
  })
})
