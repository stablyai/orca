import { expect, it, vi } from 'vitest'

import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../src/shared/agent-session/agent-session-runtime-capabilities'
import { HOST_TEST_SESSION } from '../../src/main/native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import {
  WORKTREE,
  store,
  host,
  runtime,
  call,
  createChat,
  snapshot
} from '../../src/main/runtime/rpc/methods/session-tabs/structured-chat-tab-table.test-fixture'

const logical = `agent-session:${HOST_TEST_SESSION}`
const phone = (pairedDeviceId: string) => ({
  pairedDeviceId,
  clientKind: 'mobile' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
})
const reveal = () =>
  call('agentSession.reveal', { sessionId: HOST_TEST_SESSION, navigation: 'caller' }, phone('p'))
const close = (tabId = logical) =>
  call('session.tabs.close', { worktree: WORKTREE, tabId, reason: 'user' }, phone('q'))

async function twoChats() {
  runtime.attachWindow(1)
  runtime.markGraphReady(1)
  await createChat(HOST_TEST_SESSION)
  await createChat('session-other')
  await runtime.listMobileSessionTabs(WORKTREE, 'p')
  await runtime.listMobileSessionTabs(WORKTREE, 'q')
  return 'agent-session:session-other'
}

it('concurrent caller opens share the committed ID; old omitted reveal and logical activation reuse it, retired issued IDs never alias', async () => {
  await twoChats()
  await close()
  expect(await Promise.all([reveal(), reveal()])).toMatchObject([{ ok: true }, { ok: true }])
  const issued = store.getSessionTabId(HOST_TEST_SESSION)!
  expect(
    (await snapshot()).tabs.filter(
      (tab) => tab.type === 'agent-session' && tab.sessionId === HOST_TEST_SESSION
    )
  ).toHaveLength(1)
  expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
    ok: true
  })
  expect((await snapshot()).activeTabId).toBe(issued)
  expect(
    await call(
      'session.tabs.activate',
      { worktree: WORKTREE, tabId: logical, navigation: 'all' },
      phone('p')
    )
  ).toMatchObject({ ok: true })
  expect((await snapshot()).activeTabId).toBe(issued)
  expect(await close(issued)).toMatchObject({ result: { retirementConfirmed: true } })
  expect(await reveal()).toMatchObject({ ok: true })
  expect(store.getSessionTabId(HOST_TEST_SESSION)).not.toBe(issued)
  expect(
    await call('session.tabs.activate', { worktree: WORKTREE, tabId: issued }, phone('p'))
  ).toMatchObject({ ok: false })
  expect(await close(issued)).toMatchObject({ ok: false })
})

it('a renderer-delayed close cannot hide or stop the replacement selected by a newer action', async () => {
  await twoChats()
  const receipt = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn(),
    closeSessionTab: async () => {
      entered.resolve()
      await receipt.promise
    }
  })
  const old = close()
  await entered.promise
  runtime.setNotifier(null)
  try {
    expect(await close()).toMatchObject({ result: { retirementConfirmed: true } })
    expect(await reveal()).toMatchObject({ ok: true })
    const issued = store.getSessionTabId(HOST_TEST_SESSION)!
    const stop = vi.spyOn(host, 'close')
    receipt.resolve()
    expect((await old).result).toEqual({ closed: true })
    expect(stop).not.toHaveBeenCalled()
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(issued)
    expect(
      (await runtime.listMobileSessionTabs(WORKTREE, 'q')).tabs.some((tab) => tab.id === issued)
    ).toBe(true)
  } finally {
    receipt.resolve()
    await old
  }
})
