import { afterEach, expect, it, vi } from 'vitest'
import { makeAutomation } from '@/components/automations/automations-page-fixtures'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import {
  captureAutomationReceiptSource,
  openReceiptAutomation,
  readAutomationReceipt
} from './automation-receipt-client'

const fixture = vi.hoisted(() => {
  const state: { navigation: unknown; status: Map<string, unknown>; reply: unknown } = {
    navigation: null,
    status: new Map(),
    reply: {}
  }
  return state
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      runtimeStatusByEnvironmentId: fixture.status,
      setPendingAutomationRunNavigation: (next: unknown) => {
        fixture.navigation = next
      },
      openAutomationsPage: () => {}
    })
  }
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async () => fixture.reply
}))

const automation = makeAutomation({
  id: 'collision',
  createdAt: 42,
  bot: { botId: 'bot-X', runsIn: 'new', resultsTo: 'none' }
})
const saved = {
  change: 'created' as const,
  automation: {
    id: 'collision',
    name: 'Saved',
    enabled: true,
    nextRunAt: 0,
    updatedAt: 50,
    dtstart: 0,
    rrule: '0 * * * *',
    workspaceId: null,
    bot: { botId: 'bot-X' }
  },
  receiptFacts: {
    version: 1,
    automationCreatedAt: 42,
    zone: { kind: 'not-recorded' },
    triggerExtras: { coverage: 'complete', items: [] }
  }
}
const owner = { selector: { kind: 'self' as const } }

afterEach(() => {
  fixture.navigation = null
  fixture.status.clear()
  replaceRuntimeEnvironmentRevisions([])
})

it('keeps a saved-only receipt on an older host without attempting a bare-id fallback', async () => {
  const source = captureAutomationReceiptSource(
    { target: { kind: 'local' }, sessionId: 'legacy', worktreeId: 'project-Y' },
    'receipt',
    saved
  )!
  fixture.reply = Promise.reject(
    new RuntimeRpcCallError({
      id: 'r',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' }
    })
  )
  expect(await readAutomationReceipt(source)).toEqual({ status: 'unverified' })
  expect(fixture.navigation).toBeNull()
})

it('maps the same native receipt to writer-local and viewer-paired authority, independent of the visible workspace', async () => {
  fixture.reply = { status: 'ready', automation, owner }
  const local = captureAutomationReceiptSource(
    { target: { kind: 'local' }, sessionId: 'chat-on-W', worktreeId: 'project-Y' },
    'receipt',
    saved
  )!
  expect(openReceiptAutomation(local, automation, owner, null)).toBe(true)
  expect(fixture.navigation).toMatchObject({
    hostId: 'local',
    expectedDefinition: { owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } } }
  })
  replaceRuntimeEnvironmentRevisions([{ id: 'E', createdAt: 1, pairingRevision: 7 }])
  fixture.status.set('E', { status: { runtimeId: 'W' } })
  const paired = captureAutomationReceiptSource(
    {
      target: { kind: 'environment', environmentId: 'E' },
      sessionId: 'chat-on-W',
      worktreeId: 'bot-Y'
    },
    'receipt',
    saved
  )!
  const read = await readAutomationReceipt(paired)
  if (read.status !== 'ready') {
    throw new Error('Expected a verified native receipt')
  }
  expect(openReceiptAutomation(paired, read.automation, read.owner, null)).toBe(true)
  expect(fixture.navigation).toMatchObject({
    automationId: 'collision',
    hostId: 'runtime:E',
    expectedDefinition: {
      createdAt: 42,
      runtimeId: 'W',
      owner: {
        authority: { kind: 'runtime', environmentId: 'E', pairingRevision: 7 },
        selector: { kind: 'self' }
      }
    }
  })
})

it('refuses creation/bot mismatches, re-pairing, restarts and unsupported nested SSH navigation', async () => {
  replaceRuntimeEnvironmentRevisions([{ id: 'E', createdAt: 1, pairingRevision: 7 }])
  fixture.status.set('E', { status: { runtimeId: 'W' } })
  const source = captureAutomationReceiptSource(
    {
      target: { kind: 'environment', environmentId: 'E' },
      sessionId: 'chat-on-W',
      worktreeId: 'project-Y'
    },
    'receipt',
    saved
  )!
  fixture.reply = { status: 'ready', automation: { ...automation, createdAt: 99 }, owner }
  expect(await readAutomationReceipt(source)).toEqual({ status: 'mismatch' })
  expect(openReceiptAutomation(source, { ...automation, createdAt: 99 }, owner, null)).toBe(false)
  fixture.reply = { status: 'ready', automation: { ...automation, bot: { botId: 'bot-Y' } }, owner }
  expect(await readAutomationReceipt(source)).toEqual({ status: 'mismatch' })
  expect(
    openReceiptAutomation(
      source,
      automation,
      { selector: { kind: 'ssh', targetId: 'nested', targetGeneration: 2 } },
      null
    )
  ).toBe(false)
  fixture.status.set('E', { status: { runtimeId: 'W-restarted' } })
  expect(openReceiptAutomation(source, automation, owner, null)).toBe(false)
  fixture.status.set('E', { status: { runtimeId: 'W' } })
  replaceRuntimeEnvironmentRevisions([{ id: 'E', createdAt: 1, pairingRevision: 8 }])
  expect(openReceiptAutomation(source, automation, owner, null)).toBe(false)
  expect(fixture.navigation).toBeNull()
})
