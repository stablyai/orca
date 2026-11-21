// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'

const host = vi.hoisted((): { capabilities: string[]; connected: boolean } => ({
  capabilities: [],
  connected: true
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  ensureRuntimeEnvironmentCompatible: async () => ({
    runtimeId: 'server',
    capabilities: host.capabilities
  })
}))
vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: () => undefined
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-environment-call', () => ({
  callRuntimeEnvironmentWithRevision: async () => {
    host.connected = false
    return { ok: true, result: { ok: true, value: undefined } }
  }
}))

import { botSlackCalls } from './bot-connector-host-calls'

beforeEach(() => {
  host.capabilities = []
  host.connected = true
})

it('keeps a missing workspace from reaching an older paired host’s unscoped removal', async () => {
  const result = await botSlackCalls('runtime:server').remove(
    { botId: 'bot-1', teamId: 'T2' },
    true
  )
  expect(result.ok).toBe(false)
  expect(host.connected).toBe(true)
})

it('removes a missing workspace through a host that checks the selected workspace', async () => {
  host.capabilities = ['bots.slack.scoped-remove.v1']
  const result = await botSlackCalls('runtime:server').remove(
    { botId: 'bot-1', teamId: 'T2' },
    true
  )
  expect(result.ok).toBe(true)
  expect(host.connected).toBe(false)
})

it('keeps the existing removal path for a workspace an older host already identifies', async () => {
  const result = await botSlackCalls('runtime:server').remove({ botId: 'bot-1', teamId: 'T1' })
  expect(result.ok).toBe(true)
  expect(host.connected).toBe(false)
})
