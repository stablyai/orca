// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { notifyWebhooksChanged } from '@/components/bots/webhooks/use-webhook-data'
import { setWebhookHostTransportForTests } from '@/components/bots/webhooks/webhook-host-client'
import { webhookSummaryFixture } from '@/components/bots/webhooks/webhook-summary.test-fixture'
import type { WebhookSummary } from '../../../../shared/rpc-contract/webhooks-params'
import { NativeChatWebhookCard } from './NativeChatWebhookCard'

const chat = vi.hoisted((): { botId: string | null } => ({ botId: 'bot-1' }))
const scout = { id: 'bot-1', name: 'Scout' }
const otto = { id: 'bot-2', name: 'Otto' }

vi.mock('@/components/bots/bot-workspace', () => ({
  useBotForWorkspace: () => [scout, otto].find((bot) => bot.id === chat.botId) ?? null
}))
vi.mock('@/lib/bot-catalog', () => ({ useBots: () => [scout, otto] }))

const KEY = {
  key: 'orcawh_secretsecret',
  url: 'https://connector.orca.dev/hooks/wh_7Kx2pQ9mT4vB8nLc/orcawh_secretsecret'
}
const confirm = vi.fn()
const OWNER = { target: { kind: 'local' } as const, sessionId: 's-1', worktreeId: 'folder:fw-1' }

function renderCard(
  summary: WebhookSummary,
  card: () => Promise<WebhookSummary> = async () => summary,
  reveal: () => Promise<typeof KEY> = async () => KEY
): ReturnType<typeof vi.fn> {
  const host = vi.fn(async (_target: unknown, method: string) =>
    method === 'webhooks.card' ? card() : method === 'webhooks.reveal' ? reveal() : {}
  )
  setWebhookHostTransportForTests(host)
  render(
    <ConfirmationDialogContext.Provider value={confirm}>
      <NativeChatWebhookCard owner={OWNER} hookId={summary.hookId} />
    </ConfirmationDialogContext.Provider>
  )
  return host
}

beforeEach(() => {
  chat.botId = 'bot-1'
  Object.assign(window, { api: { ui: { writeSecretClipboardText: vi.fn(async () => {}) } } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setWebhookHostTransportForTests(null)
  Reflect.deleteProperty(window, 'api')
})

describe('NativeChatWebhookCard', () => {
  it('says where the URL is in another bot’s chat, without the card', async () => {
    chat.botId = 'bot-2'
    renderCard(webhookSummaryFixture())
    expect(
      await screen.findByText(
        'Webhook “Investigate Sentry alert” is live. Copy its URL from Orca on a computer: Settings › Bots › Scout › Webhooks. To pause or delete it, ask Scout here.'
      )
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull()
  })

  it('reveals the key on click until the owner hides it', async () => {
    const host = renderCard(webhookSummaryFixture())
    const reveal = await screen.findByRole('button', { name: 'Reveal' })
    expect(screen.getByText('Webhook · starts “Investigate Sentry alert”')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add signing secret…' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('orcawh_')
    fireEvent.click(reveal)
    const url = await screen.findByText(KEY.url)
    expect(url.closest('[data-native-chat-secret][data-native-chat-find-skip]')).toBeTruthy()
    expect(host).toHaveBeenCalledWith(OWNER.target, 'webhooks.reveal', {
      hookId: 'wh_7Kx2pQ9mT4vB8nLc'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(document.body.textContent).not.toContain('orcawh_')
  })

  it('copies through the secret clipboard without putting the key on screen', async () => {
    const host = renderCard(webhookSummaryFixture())
    fireEvent.click(await screen.findByRole('button', { name: 'Copy key' }))
    await waitFor(() =>
      expect(window.api.ui.writeSecretClipboardText).toHaveBeenCalledWith(KEY.key)
    )
    expect(host).toHaveBeenCalledWith(OWNER.target, 'webhooks.reveal', {
      hookId: 'wh_7Kx2pQ9mT4vB8nLc'
    })
    expect(document.body.textContent).not.toContain('orcawh_')
  })

  it('keeps a shown key across a refresh until the key generation changes', async () => {
    let summary = webhookSummaryFixture()
    renderCard(summary, async () => summary)
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal' }))
    await screen.findByText(KEY.url)
    summary = { ...summary, pendingCalls: 1 }
    act(() => notifyWebhooksChanged())
    await waitFor(() => expect(screen.getByText(KEY.url)).toBeTruthy())

    summary = { ...summary, keyGeneration: summary.keyGeneration + 1 }
    act(() => notifyWebhooksChanged())
    await waitFor(() => expect(document.body.textContent).not.toContain('orcawh_'))
  })

  it('keeps the card and a shown key when a refresh fails, with the reason above it', async () => {
    const summary = webhookSummaryFixture()
    let failing = false
    renderCard(summary, async () => {
      if (failing) {
        throw new Error('unreachable')
      }
      return summary
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal' }))
    await screen.findByText(KEY.url)
    failing = true
    act(() => notifyWebhooksChanged())
    expect(await screen.findByText('Something went wrong. Try again.')).toBeTruthy()
    expect(screen.getByText('Webhook · starts “Investigate Sentry alert”')).toBeTruthy()
    expect(screen.getByText(KEY.url)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Send a sample call' }).hasAttribute('disabled')
    ).toBe(true)
  })

  it('discards a shown key when the hook pauses, and never brings it back on resume', async () => {
    let summary = webhookSummaryFixture()
    const host = renderCard(summary, async () => summary)
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal' }))
    await screen.findByText(KEY.url)
    summary = { ...summary, state: 'paused' }
    act(() => notifyWebhooksChanged())
    await screen.findByText('Paused')
    summary = { ...summary, state: 'live' }
    act(() => notifyWebhooksChanged())
    await screen.findByText('No calls yet')
    expect(document.body.textContent).not.toContain('orcawh_')
    expect(host.mock.calls.filter(([, method]) => method === 'webhooks.reveal')).toHaveLength(1)
  })
})
