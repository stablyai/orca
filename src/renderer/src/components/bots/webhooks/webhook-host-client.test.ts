import { afterEach, expect, it, vi } from 'vitest'
import {
  callWebhookHost,
  setWebhookHostTransportForTests,
  webhookHostKey,
  WebhookHostChangedError
} from './webhook-host-client'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: async () => ({}) }))

const sent: unknown[][] = []
afterEach(() => {
  sent.length = 0
  setWebhookHostTransportForTests(null)
})

function answer(reply: Promise<unknown> = Promise.resolve({ url: 'u', key: 'k' })): void {
  setWebhookHostTransportForTests(async (...call) => {
    sent.push(call)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: answers webhooks.reveal, whose result is a WebhookKey.
    return (await reply) as never
  })
}

it('sends an unbound target as before, with no incarnation expected', async () => {
  answer()
  await callWebhookHost({ kind: 'environment', environmentId: 'E' }, 'webhooks.reveal', {
    hookId: 'wh_a'
  })
  expect(sent).toEqual([
    [{ kind: 'environment', environmentId: 'E' }, 'webhooks.reveal', { hookId: 'wh_a' }]
  ])
})

it('pins a bound call to its pairing and runtime, refuses it once the host changed, and drops a late reply', async () => {
  let current = true
  const target = {
    kind: 'environment' as const,
    environmentId: 'E',
    binding: { pairingRevision: 7, runtimeId: 'W', current: () => current }
  }
  answer()
  await callWebhookHost(target, 'webhooks.reveal', { hookId: 'wh_a' })
  expect(sent).toEqual([
    [
      { kind: 'environment', environmentId: 'E' },
      'webhooks.reveal',
      { hookId: 'wh_a' },
      { pairingRevision: 7, runtimeId: 'W' }
    ]
  ])

  const held = Promise.withResolvers<unknown>()
  answer(held.promise)
  const late = callWebhookHost(target, 'webhooks.reveal', { hookId: 'wh_a' })
  current = false
  held.resolve({ url: 'u', key: 'k' })
  await expect(late).rejects.toBeInstanceOf(WebhookHostChangedError)

  sent.length = 0
  await expect(
    callWebhookHost(target, 'webhooks.reveal', { hookId: 'wh_a' })
  ).rejects.toBeInstanceOf(WebhookHostChangedError)
  expect(sent).toEqual([])
})

it('keys a bound host’s reads by its incarnation', () => {
  const binding = { pairingRevision: 7, runtimeId: 'W', current: () => true }
  expect(webhookHostKey({ kind: 'local' })).toBe('local')
  expect(webhookHostKey({ kind: 'environment', environmentId: 'E' })).toBe('env:E')
  expect(webhookHostKey({ kind: 'environment', environmentId: 'E', binding })).toBe('env:E@7:W')
})
