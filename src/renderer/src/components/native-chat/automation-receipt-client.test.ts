import { afterEach, expect, it, vi } from 'vitest'
import { makeAutomation } from '@/components/automations/automations-page-fixtures'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import {
  captureAutomationReceiptSource,
  deleteReceiptAutomation,
  openCardAutomation,
  openReceiptAutomation,
  readAutomationReceipt
} from './automation-receipt-client'

const fixture = vi.hoisted(() => {
  const navigation: unknown = null
  const reply: unknown = {}
  const state = {
    navigation,
    status: new Map<string, unknown>(),
    reply,
    listeners: new Set<() => void>(),
    view: {
      activeView: 'terminal',
      activeWorktreeId: 'project-Y',
      activeGroupIdByWorktree: { 'project-Y': 'chat-group' },
      groupsByWorktree: { 'project-Y': [{ id: 'chat-group', activeTabId: 'chat-tab' }] },
      unifiedTabsByWorktree: { 'project-Y': [{ id: 'chat-tab', groupId: 'chat-group' }] }
    }
  }
  return state
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...fixture.view,
      runtimeStatusByEnvironmentId: fixture.status,
      setPendingAutomationRunNavigation: (next: unknown) => {
        fixture.navigation = next
      },
      openAutomationsPage: () => {}
    }),
    subscribe: (listener: () => void) => {
      fixture.listeners.add(listener)
      return () => fixture.listeners.delete(listener)
    }
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
  fixture.view.activeView = 'terminal'
  fixture.view.activeWorktreeId = 'project-Y'
  fixture.view.groupsByWorktree = { 'project-Y': [{ id: 'chat-group', activeTabId: 'chat-tab' }] }
  fixture.listeners.clear()
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

it.each(['local', 'paired'] as const)(
  'does not navigate after leaving and returning during a delayed %s receipt read',
  async (host) => {
    replaceRuntimeEnvironmentRevisions([{ id: 'E', createdAt: 1, pairingRevision: 7 }])
    fixture.status.set('E', { status: { runtimeId: 'W' } })
    const reply = Promise.withResolvers<unknown>()
    fixture.reply = reply.promise
    const opening = openCardAutomation(
      {
        target: host === 'local' ? { kind: 'local' } : { kind: 'environment', environmentId: 'E' },
        sessionId: 'chat-on-W',
        worktreeId: 'project-Y',
        tabId: 'chat-tab'
      },
      'receipt',
      saved,
      false,
      new AbortController().signal
    )
    fixture.view.activeView = 'automations'
    fixture.listeners.forEach((listener) => listener())
    fixture.view.activeView = 'terminal'
    fixture.listeners.forEach((listener) => listener())
    reply.resolve({ status: 'ready', automation, owner })
    expect(await opening).toBe('stale')
    expect(fixture.navigation).toBeNull()
  }
)

it('does not navigate a late response after its receipt view is disposed', async () => {
  const reply = Promise.withResolvers<unknown>()
  fixture.reply = reply.promise
  const lifetime = new AbortController()
  const opening = openCardAutomation(
    {
      target: { kind: 'local' },
      sessionId: 'chat-on-W',
      worktreeId: 'project-Y',
      tabId: 'chat-tab'
    },
    'receipt',
    saved,
    false,
    lifetime.signal
  )
  lifetime.abort()
  reply.resolve({ status: 'ready', automation, owner })
  expect(await opening).toBe('stale')
  expect(fixture.navigation).toBeNull()
})

it('returns an unremoved definition result without claiming a successful deletion', async () => {
  const source = captureAutomationReceiptSource(
    { target: { kind: 'local' }, sessionId: 'chat-on-W', worktreeId: 'project-Y' },
    'receipt',
    saved
  )!
  fixture.reply = { id: 'collision', removed: false }
  expect(await deleteReceiptAutomation(source, automation, owner)).toBe(false)
})

it('opens a receipt while its original view and host remain current', async () => {
  fixture.reply = { status: 'ready', automation, owner }
  expect(
    await openCardAutomation(
      {
        target: { kind: 'local' },
        sessionId: 'chat-on-W',
        worktreeId: 'project-Y',
        tabId: 'chat-tab'
      },
      'receipt',
      saved,
      false,
      new AbortController().signal
    )
  ).toBe('opened')
  expect(fixture.navigation).toMatchObject({ automationId: 'collision', hostId: 'local' })
})

it.each(['workspace', 'tab'] as const)(
  'fences delayed Open after a transient %s change',
  async (part) => {
    const reply = Promise.withResolvers<unknown>()
    fixture.reply = reply.promise
    const opening = openCardAutomation(
      {
        target: { kind: 'local' },
        sessionId: 'chat-on-W',
        worktreeId: 'project-Y',
        tabId: 'chat-tab'
      },
      'receipt',
      saved,
      false,
      new AbortController().signal
    )
    if (part === 'workspace') {
      fixture.view.activeWorktreeId = 'project-Z'
    } else {
      fixture.view.groupsByWorktree = {
        'project-Y': [{ id: 'chat-group', activeTabId: 'other-tab' }]
      }
    }
    fixture.listeners.forEach((listener) => listener())
    fixture.view.activeWorktreeId = 'project-Y'
    fixture.view.groupsByWorktree = { 'project-Y': [{ id: 'chat-group', activeTabId: 'chat-tab' }] }
    fixture.listeners.forEach((listener) => listener())
    reply.resolve({ status: 'ready', automation, owner })
    expect(await opening).toBe('stale')
    expect(fixture.navigation).toBeNull()
  }
)
