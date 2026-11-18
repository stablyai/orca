// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import { notifyWebhooksChanged, useBotWebhooks, usePendingWebhookSummary } from './use-webhook-data'
import { setWebhookHostTransportForTests } from './webhook-host-client'
import { webhookSummaryFixture } from './webhook-summary.test-fixture'
import type { WebhookSummary } from '../../../../../shared/rpc-contract/webhooks-params'

const LOCAL = { kind: 'local' } as const

function HookCount({ botId }: { botId: string }): React.JSX.Element {
  const read = useBotWebhooks(LOCAL, botId)
  return <p>{read.status === 'ready' ? `${botId}: ${read.value.length}` : read.status}</p>
}

function PendingHook(): React.JSX.Element {
  const read = usePendingWebhookSummary(LOCAL, 'wh_1')
  return <p>{read.status === 'ready' ? read.value.state : read.status}</p>
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  setWebhookHostTransportForTests(null)
})

describe('webhook host reads', () => {
  it('reads a key once for every reader, and again for all of them after a change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const host = vi.fn(async () => ({ hooks: [webhookSummaryFixture()] }))
    setWebhookHostTransportForTests(host)
    render(
      <>
        <HookCount botId="bot-1" />
        <HookCount botId="bot-1" />
        <HookCount botId="bot-2" />
      </>
    )
    expect(await screen.findAllByText('bot-1: 1')).toHaveLength(2)
    await screen.findByText('bot-2: 1')
    expect(host).toHaveBeenCalledTimes(2)
    await act(async () => notifyWebhooksChanged())
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(host).toHaveBeenCalledTimes(4)
  })

  it("reads again on the host's botsChanged, as a call's run starts or ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const host = vi.fn(async () => ({ hooks: [webhookSummaryFixture()] }))
    setWebhookHostTransportForTests(host)
    render(<HookCount botId="bot-1" />)
    await screen.findByText('bot-1: 1')
    await act(async () => emitBotsChangedWindowEvent('local'))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(host).toHaveBeenCalledTimes(2)
  })

  it("doesn't read again on focus before a key is due", async () => {
    const host = vi.fn(async () => ({ hooks: [webhookSummaryFixture()] }))
    setWebhookHostTransportForTests(host)
    render(<HookCount botId="bot-1" />)
    await screen.findByText('bot-1: 1')
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(host).toHaveBeenCalledTimes(1)
  })

  // A saved-automation card waits for its hook's URL; once live, nothing keeps reading.
  it('polls a pending hook only until it is live, and not once unmounted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let state: WebhookSummary['state'] = 'pending'
    const host = vi.fn(async () => webhookSummaryFixture({ state }))
    setWebhookHostTransportForTests(host)
    const view = render(<PendingHook />)
    await screen.findByText('pending')
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(host).toHaveBeenCalledTimes(2)
    state = 'live'
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    await screen.findByText('live')
    const reads = host.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(120_000))
    expect(host).toHaveBeenCalledTimes(reads)

    state = 'pending'
    await act(async () => notifyWebhooksChanged())
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    await screen.findByText('pending')
    view.unmount()
    const afterUnmount = host.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(120_000))
    expect(host).toHaveBeenCalledTimes(afterUnmount)
  })
})
