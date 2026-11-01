import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  authorityProfile,
  AuthorityRuntime,
  openAuthorityRuntime,
  B,
  C,
  root
} from '../../src/main/runtime/structured-agent-session-tab-authority.test-support'
import { closeTestJournalHostDatabases } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { journalDatabasePath } from '../../src/main/native-chat/agent-session-journal/journal-host-database'
import { getStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredAgentSessionHostRefusal } from '../../src/main/runtime/agent-session/structured-agent-session-host-refusal'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { SESSION_TAB_CLOSE_METHODS } from '../../src/main/runtime/rpc/methods/session-tab-close-methods'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../src/shared/agent-session/agent-session-runtime-capabilities'
import type { RuntimeMobileSessionTabsSnapshot } from '../../src/shared/runtime-types'
import { createMobileCreateTestNotifier } from '../../src/main/runtime/orca-runtime-test-scenario-builders.spec'
import { sessionTabClose } from '../../mobile/src/session/mobile-session-write-operations'
import { newReopenedChatTabId } from '../../src/main/runtime/agent-session/agent-session-tab-identity'
vi.mock('../../src/main/claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))

async function refusedRuntime(ids = [B, C]) {
  const rig = await authorityProfile(ids)
  await closeTestJournalHostDatabases()
  const path = journalDatabasePath(root),
    journal = readFileSync(path)
  writeFileSync(path, 'fixture: unreadable SQLite journal')
  const runtime = new AuthorityRuntime(rig.profile)
  await runtime.prepareStructuredAgentSessionStartupRestoration()
  expect(structuredAgentSessionHostRefusal()).not.toBeNull()
  expect(getStructuredAgentSessionHost()).toBeNull()
  return { rig, runtime, path, journal }
}

it.each([
  'ack',
  'already-removed',
  'cancelled',
  'error',
  'vanished',
  'successor',
  'moved',
  'legacy-frame',
  'host-installed'
] as const)(
  'settles an admitted raw-only close after real startup journal refusal: %s',
  async (mode) => {
    const { rig, runtime, path, journal } = await refusedRuntime()
    const old = `agent-session:${B}`,
      other = `agent-session:${C}`
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: rig.workspace,
      publicationEpoch: 'renderer',
      snapshotVersion: 1,
      activeGroupId: 'g',
      activeTabId: old,
      activeTabType: 'agent-session',
      tabGroups: [{ id: 'g', activeTabId: old, tabOrder: [old, other] }],
      tabs: [
        {
          type: 'agent-session',
          id: old,
          title: 'Codex Chat',
          sessionId: B,
          agent: 'codex',
          isActive: true
        },
        {
          type: 'agent-session',
          id: other,
          title: 'Codex Chat',
          sessionId: C,
          agent: 'codex',
          isActive: false
        }
      ]
    }
    const publish = (frames: RuntimeMobileSessionTabsSnapshot[]) =>
      runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: frames })
    publish([snapshot])
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const renderer = vi.fn(async () => {
      entered.resolve()
      await release.promise
      if (mode === 'already-removed') {
        throw new Error('session_tab_not_found')
      }
      if (mode === 'cancelled' || mode === 'error') {
        throw new Error(mode)
      }
    })
    runtime.setNotifier({ ...createMobileCreateTestNotifier(vi.fn()), closeSessionTab: renderer })
    const rpc = new RpcDispatcher({ runtime, methods: SESSION_TAB_CLOSE_METHODS })
    const close = (tabId: string) =>
      rpc.dispatch(
        {
          id: 'close',
          authToken: 'token',
          method: 'session.tabs.close',
          params: { worktree: `id:${rig.workspace}`, tabId, reason: 'user' }
        },
        {
          pairedDeviceId: 'phone',
          clientKind: 'mobile',
          clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
        }
      )
    const saved = rig.profile
      .getWorkspaceSession('local')
      .unifiedTabs?.[rig.workspace]?.map((row) => row.id)
    const pending = close(old)
    await entered.promise
    let survivor: string | null = null
    let installed: Awaited<ReturnType<typeof openAuthorityRuntime>> | undefined
    try {
      if (mode === 'vanished') {
        publish([
          { ...snapshot, snapshotVersion: 2, tabs: snapshot.tabs.filter((row) => row.id !== old) }
        ])
      }
      if (mode === 'successor') {
        survivor = newReopenedChatTabId()
        publish([
          {
            ...snapshot,
            snapshotVersion: 2,
            tabs: snapshot.tabs.map((row) => (row.id === old ? { ...row, id: survivor! } : row))
          }
        ])
      }
      if (mode === 'moved') {
        survivor = old
        publish([
          { ...snapshot, snapshotVersion: 2, tabs: snapshot.tabs.filter((row) => row.id !== old) },
          {
            ...snapshot,
            worktree: 'unowned-workspace',
            snapshotVersion: 2,
            tabs: snapshot.tabs.filter((row) => row.id === old)
          }
        ])
      }
      if (mode === 'legacy-frame') {
        publish([
          {
            ...snapshot,
            snapshotVersion: 20,
            publicationEpoch: 'ordinary-new-frame',
            tabs: snapshot.tabs.map((row) => ({ ...row }))
          }
        ])
      }
      if (mode === 'host-installed') {
        writeFileSync(path, journal)
        installed = await openAuthorityRuntime(rig, runtime)
        await installed.host.setSessionTabVisibility(B, false)
        await runtime.publishStructuredAgentSessionTab({
          workspaceId: rig.workspace,
          sessionId: B,
          agent: 'codex',
          activate: false,
          navigation: 'caller'
        })
        survivor = installed.store.getSessionTabId(B)
      }
      release.resolve()
      const result = await pending
      if (mode === 'cancelled' || mode === 'error') {
        expect(result).toMatchObject({ ok: false })
        expect(
          runtime.mobileSessionTabsByWorktree.get(rig.workspace)?.tabs.some((row) => row.id === old)
        ).toBe(true)
      } else {
        expect(result).toMatchObject({ ok: true, result: { closed: true } })
        if (result.ok) {
          expect(result.result).not.toHaveProperty('retirementConfirmed')
          expect(
            sessionTabClose.interpret({ id: result.id, ok: true, result: result.result })
          ).toEqual({ accepted: true, value: { refused: false, retirementConfirmed: false } })
        }
        const raw = [...runtime.mobileSessionTabsByWorktree.values()].flatMap((frame) => frame.tabs)
        expect(raw.some((row) => row.id === (survivor ?? old))).toBe(survivor !== null)
        expect(raw.some((row) => row.id === other)).toBe(true)
        if (installed) {
          expect(installed.store.getSessionTabId(B)).toBe(survivor)
          expect(installed.acquire).not.toHaveBeenCalled()
        } else {
          expect(getStructuredAgentSessionHost()).toBeNull()
          expect(
            rig.profile
              .getWorkspaceSession('local')
              .unifiedTabs?.[rig.workspace]?.map((row) => row.id)
          ).toEqual(saved)
        }
      }
      if (mode === 'ack' || mode === 'already-removed' || mode === 'legacy-frame') {
        expect(
          (await runtime.listMobileSessionTabs(`id:${rig.workspace}`)).tabs.some(
            (row) => row.id === old
          )
        ).toBe(false)
        expect(await close(old)).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining('tab_not_found') }
        })
        expect(await close(other)).toMatchObject({ ok: true, result: { closed: true } })
        expect(runtime.mobileSessionTabsByWorktree.get(rig.workspace)?.tabs).toHaveLength(0)
      }
    } finally {
      release.resolve()
      await pending
    }
  }
)

it.each([10, 100])(
  'counts the real hostless RPC raw retirement at %i rows/groups/workspaces',
  async (n) => {
    const ids = Array.from({ length: n }, (_, i) => `raw-${i}`)
    const { rig, runtime } = await refusedRuntime(ids)
    const target = `agent-session:${ids[0]}`
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: rig.workspace,
      publicationEpoch: 'refused-host',
      snapshotVersion: 1,
      activeGroupId: 'g0',
      activeTabId: target,
      activeTabType: 'agent-session',
      tabs: ids.map((sessionId, i) => ({
        id: `agent-session:${sessionId}`,
        type: 'agent-session',
        sessionId,
        agent: 'codex',
        title: 'Codex Chat',
        isActive: i === 0
      })),
      tabGroups: ids.map((id, i) => ({
        id: `g${i}`,
        activeTabId: `agent-session:${id}`,
        tabOrder: [`agent-session:${id}`],
        recentTabIds: [`agent-session:${id}`]
      }))
    }
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        snapshot,
        ...ids.map((_, i) => ({ ...snapshot, worktree: `unowned-${i}`, tabs: [], tabGroups: [] }))
      ]
    })
    const counts = { raw: 0, order: 0, saved: 0, workspaces: 0, writes: 0 }
    const arrays = new WeakSet<object>(),
      savedRows = new WeakSet<object>()
    const instrument = (rows: unknown[], key: 'raw' | 'order') => {
      if (arrays.has(rows)) {
        return
      }
      arrays.add(rows)
      for (const [index, row] of rows.entries()) {
        Object.defineProperty(rows, index, {
          get: () => {
            counts[key]++
            return row
          }
        })
      }
    }
    const wrap = (frame: RuntimeMobileSessionTabsSnapshot) => {
      instrument(frame.tabs, 'raw')
      for (const group of frame.tabGroups ?? []) {
        instrument(group.tabOrder, 'order')
        if (group.recentTabIds) {
          instrument(group.recentTabIds, 'order')
        }
      }
    }
    for (const frame of runtime.mobileSessionTabsByWorktree.values()) {
      wrap(frame)
    }
    const store = runtime.storeMobileSessionSnapshot.bind(runtime)
    vi.spyOn(runtime, 'storeMobileSessionSnapshot').mockImplementation((workspace, frame) => {
      counts.writes++
      wrap(frame)
      const value = store(workspace, frame)
      wrap(value)
      return value
    })
    const saved = rig.profile.getWorkspaceSession.bind(rig.profile)
    vi.spyOn(rig.profile, 'getWorkspaceSession').mockImplementation((...args) => {
      const session = saved(...args)
      for (const rows of Object.values(session.unifiedTabs ?? {})) {
        for (const row of rows) {
          if (savedRows.has(row)) {
            continue
          }
          savedRows.add(row)
          const id = row.entityId
          Object.defineProperty(row, 'entityId', {
            get: () => {
              counts.saved++
              return id
            }
          })
        }
      }
      return session
    })
    const entries = runtime.mobileSessionTabsByWorktree[Symbol.iterator].bind(
      runtime.mobileSessionTabsByWorktree
    )
    vi.spyOn(runtime.mobileSessionTabsByWorktree, Symbol.iterator).mockImplementation(function* () {
      for (const entry of entries()) {
        counts.workspaces++
        yield entry
      }
      return undefined
    })
    runtime.setNotifier({
      ...createMobileCreateTestNotifier(vi.fn()),
      closeSessionTab: async () => {}
    })
    const result = await new RpcDispatcher({
      runtime,
      methods: SESSION_TAB_CLOSE_METHODS
    }).dispatch(
      {
        id: 'close',
        authToken: 'token',
        method: 'session.tabs.close',
        params: { worktree: `id:${rig.workspace}`, tabId: target, reason: 'user' }
      },
      {
        pairedDeviceId: 'p',
        clientKind: 'mobile',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
    )
    const actual = { ...counts }
    expect(result).toMatchObject({ ok: true, result: { closed: true } })
    // Admission/projection and retirement each traverse the selected rows/orders; outer retirement visits W.
    expect(actual.raw + actual.order).toBeLessThanOrEqual(24 * n)
    expect(actual.workspaces).toBeLessThanOrEqual(n + 1)
    // Pre/post projection resolves each title against the saved-row population; no linear claim for that scan.
    expect(actual.saved).toBeLessThanOrEqual(3 * n * n + 8 * n)
    expect(actual.writes).toBe(1)
    expect(
      runtime.mobileSessionTabsByWorktree.get(rig.workspace)?.tabs.some((row) => row.id === target)
    ).toBe(false)
    expect(rig.profile.getWorkspaceSession('local').unifiedTabs?.[rig.workspace]).toHaveLength(n)
    expect(getStructuredAgentSessionHost()).toBeNull()
  }
)
