import {
  resolveActiveSessionTab47713,
  notificationPaneTab47713
} from './structured-chat-tab-lifetime.test-fixture'
import { expect, it, vi } from 'vitest'
import { resolveActiveSessionTab } from '../../mobile/src/session/active-session-tab'
import { notificationPaneTab } from '../../mobile/src/session/notification-pane-tab'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../src/shared/agent-session/agent-session-runtime-capabilities'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../src/shared/agent-session/view/structured-agent-session-projection'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_SESSION
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { readPersistedTestAgentSessionStore } from '../../src/main/runtime/agent-session/records/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import {
  WORKTREE,
  directory,
  store,
  host,
  runtime,
  call,
  createChat,
  snapshot,
  openHost,
  closeSession,
  send
} from '../../src/main/runtime/rpc/methods/structured-chat-tab-table.test-fixture'

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
const selected = (
  tabs: Parameters<typeof resolveActiveSessionTab>[0],
  selectedSessionTabId: string,
  pendingActiveSessionTabId: string | null = null
) =>
  (() => {
    const options = { selectedSessionTabId, pendingActiveSessionTabId }
    const pinned = resolveActiveSessionTab47713(tabs, options)
    expect(resolveActiveSessionTab(tabs, options)).toEqual(pinned)
    return pinned.activeTab?.id
  })()

async function twoChats() {
  runtime.attachWindow(1)
  runtime.markGraphReady(1)
  await createChat(HOST_TEST_SESSION)
  await createChat('session-other')
  await runtime.listMobileSessionTabs(WORKTREE, 'p')
  await runtime.listMobileSessionTabs(WORKTREE, 'q')
  return 'agent-session:session-other'
}

it('a real committed close/reopen cannot revive an old phone pick, including reconnect/restart', async () => {
  const other = await twoChats()
  const events: Awaited<ReturnType<typeof snapshot>>[] = []
  const unsubscribe = runtime.onMobileSessionTabsChanged((event) => events.push(event), 'q')
  expect(await close()).toMatchObject({ ok: true, result: { retirementConfirmed: true } })
  const absent = await runtime.listMobileSessionTabs(WORKTREE, 'q')
  expect(selected(absent.tabs, logical)).toBe(other)
  expect(absent.tabs.some((tab) => tab.id === logical)).toBe(false)
  expect(await reveal()).toMatchObject({ ok: true, result: { ok: true } })
  const issued = store.getSessionTabId(HOST_TEST_SESSION)!
  expect(issued).toMatch(/^agent-chat-tab-v1-[\da-f-]+$/)
  expect(issued).not.toContain(':')
  expect(
    notificationPaneTab47713(
      (await snapshot()).tabs,
      structuredAgentSessionPaneKey(issued, HOST_TEST_SESSION)
    )?.id
  ).toBe(issued)
  // The pinned parser rejects the preexisting colon-containing canonical spelling.
  expect(
    notificationPaneTab47713(
      (await snapshot()).tabs,
      structuredAgentSessionPaneKey(logical, HOST_TEST_SESSION)
    )
  ).toBeUndefined()
  const result = await runtime.listMobileSessionTabs(WORKTREE, 'q')
  expect(result.tabs.find((tab) => tab.id === issued)).toMatchObject({
    sessionId: HOST_TEST_SESSION,
    agent: 'codex'
  })
  expect(selected(events.at(-1)!.tabs, logical)).toBe(other)
  expect(selected(result.tabs, logical)).toBe(other)
  expect(selected(result.tabs, logical, other)).toBe(other)
  expect((await snapshot()).activeTabId).toBe(other)
  expect(runtime['clientSessionTabSelections'].serialize()).toEqual({})
  expect(
    notificationPaneTab(
      result.tabs,
      structuredAgentSessionPaneKey(
        structuredAgentSessionTabId(HOST_TEST_SESSION),
        HOST_TEST_SESSION
      )
    )?.id
  ).toBe(issued)
  expect(
    await call(
      'session.tabs.activate',
      { worktree: WORKTREE, tabId: logical, navigation: 'caller' },
      phone('p')
    )
  ).toMatchObject({ ok: true })
  expect((await runtime.listMobileSessionTabs(WORKTREE, 'p')).activeTabId).toBe(issued)
  expect((await runtime.listMobileSessionTabs(WORKTREE, 'q')).activeTabId).toBe(other)
  expect((await snapshot()).activeTabId).toBe(other)
  expect((await readPersistedTestAgentSessionStore(directory)).sessionTabs).toContainEqual({
    tabId: issued,
    sessionId: HOST_TEST_SESSION
  })
  unsubscribe()
  await host.flushAllStreamedEvents()
  await openHost()
  const restarted = new OrcaRuntimeService()
  await restarted.restoreStructuredAgentSessionTabs()
  const rebuilt = await restarted.listMobileSessionTabs(WORKTREE)
  expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(issued)
  expect(
    rebuilt.tabs
      .filter((tab) => tab.type === 'agent-session' && tab.sessionId === HOST_TEST_SESSION)
      .map((tab) => tab.id)
  ).toEqual([issued])
  expect(
    selected(
      rebuilt.tabs.map((tab) => ({ ...tab, isActive: tab.id === other })),
      logical
    )
  ).toBe(other)
})

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

it('rejects late predecessor row and focus claims, but restores the same live tab after an omission', async () => {
  const other = await twoChats()
  const predecessor = await snapshot()
  await close()
  await reveal()
  const issued = store.getSessionTabId(HOST_TEST_SESSION)!
  runtime.storeMobileSessionSnapshot(HOST_TEST_LOCATION.workspaceId, {
    ...predecessor,
    activeTabId: logical,
    tabs: predecessor.tabs.map((tab) => ({ ...tab, isActive: tab.id === logical })),
    tabGroups: predecessor.tabGroups?.map((group) => ({ ...group, activeTabId: logical }))
  })
  const accepted = await snapshot()
  expect(accepted.tabs.map((tab) => tab.id).sort()).toEqual([other, issued].sort())
  expect(accepted.activeTabId).toBe(other)
  expect(accepted.tabs.find((tab) => tab.id === issued)?.isActive).toBe(false)
  expect(accepted.tabGroups?.some((group) => group.activeTabId === issued)).toBe(false)
  runtime.storeMobileSessionSnapshot(HOST_TEST_LOCATION.workspaceId, {
    ...accepted,
    tabs: accepted.tabs.filter((tab) => tab.id !== issued)
  })
  await runtime.publishStructuredAgentSessionTab({
    sessionId: HOST_TEST_SESSION,
    workspaceId: HOST_TEST_LOCATION.workspaceId,
    agent: 'codex',
    activate: false,
    navigation: 'caller'
  })
  expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(issued)
  expect(selected((await snapshot()).tabs, issued)).toBe(issued)
})

it('a close settling after provider await retires only the captured surface', async () => {
  await twoChats()
  await send(HOST_TEST_SESSION, 'start provider')
  let finishClose!: (value: boolean) => void
  closeSession.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishClose = resolve
      })
  )
  const closing = close()
  await vi.waitFor(() => expect(closeSession).toHaveBeenCalledOnce())
  expect(store.getSessionTabId(HOST_TEST_SESSION)).toBeNull()
  expect(await reveal()).toMatchObject({ ok: true })
  const issued = store.getSessionTabId(HOST_TEST_SESSION)!
  finishClose(true)
  expect(await closing).toMatchObject({ result: { retirementConfirmed: true } })
  expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(issued)
  expect(
    (await runtime.listMobileSessionTabs(WORKTREE, 'q')).tabs.some((tab) => tab.id === issued)
  ).toBe(true)
})

it('legacy activating republish before close settlement keeps its old identity and caller-hidden bystanders', async () => {
  const other = await twoChats()
  await send(HOST_TEST_SESSION, 'start provider')
  let finishClose!: (value: boolean) => void
  closeSession.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishClose = resolve
      })
  )
  const closing = close()
  await vi.waitFor(() => expect(closeSession).toHaveBeenCalledOnce())
  expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
    ok: true
  })
  finishClose(true)
  await closing
  expect(
    (await runtime.listMobileSessionTabs(WORKTREE, 'q')).tabs.some((tab) => tab.id === logical)
  ).toBe(false)
  expect(await reveal()).toMatchObject({ ok: true })
  expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(
    structuredAgentSessionTabId(HOST_TEST_SESSION)
  )
  const p = await runtime.listMobileSessionTabs(WORKTREE, 'p')
  expect(p.activeTabId).toBe(logical)
  expect(selected(p.tabs, other)).toBe(other)
  expect(
    (await runtime.listMobileSessionTabs(WORKTREE, 'q')).tabs.some((tab) => tab.id === logical)
  ).toBe(false)
  expect(runtime['clientSessionTabSelections'].serialize()).toEqual({})
})

it('failed durable hide still stops the provider, remains unconfirmed, and reuses committed identity; failed fresh show publishes nothing', async () => {
  await twoChats()
  await send(HOST_TEST_SESSION, 'start provider')
  const db = openTestJournalHostDatabase(directory).db
  db.exec(
    "CREATE TRIGGER refuse_tab_hide BEFORE DELETE ON agent_session_tabs BEGIN SELECT RAISE(ABORT, 'test write failure'); END"
  )
  try {
    const unconfirmed = await close()
    expect(unconfirmed).toMatchObject({ ok: true })
    expect(unconfirmed.result).toEqual({ closed: true })
    expect(closeSession).toHaveBeenCalledOnce()
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(
      structuredAgentSessionTabId(HOST_TEST_SESSION)
    )
    expect(
      (await runtime.listMobileSessionTabs(WORKTREE, 'q')).tabs.some((tab) => tab.id === logical)
    ).toBe(false)
    expect(await reveal()).toMatchObject({ ok: true })
  } finally {
    db.exec('DROP TRIGGER refuse_tab_hide')
  }
  await close()
  const before = await snapshot()
  db.exec(
    "CREATE TRIGGER refuse_tab_show BEFORE INSERT ON agent_session_tabs BEGIN SELECT RAISE(ABORT, 'test write failure'); END"
  )
  try {
    expect(await reveal()).toMatchObject({ ok: false })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBeNull()
    expect((await snapshot()).tabs).toEqual(before.tabs)
    expect(
      (await readPersistedTestAgentSessionStore(directory)).sessionTabs?.some(
        (tab) => tab.sessionId === HOST_TEST_SESSION
      )
    ).toBe(false)
  } finally {
    db.exec('DROP TRIGGER refuse_tab_show')
  }
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
