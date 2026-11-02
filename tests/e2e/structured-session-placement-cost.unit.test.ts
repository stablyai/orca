import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import {
  root,
  B,
  C,
  reveal
} from '../../src/main/runtime/structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from '../../src/main/runtime/session-layout-apply.test-fixture'
import { stopStructuredAgentSessionRuntime } from '../../src/main/runtime/agent-session/structured-agent-session-runtime'
import { closeTestStores } from '../../src/main/persistence/persistence-test-harness'
import { closeTestJournalHostDatabases } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { acquireWatcherRemovalGate } from '../../src/main/ipc/watcher-removal-gate'
import { registerSessionHandlers } from '../../src/main/ipc/session'
import * as worktreeIdentity from '../../src/shared/worktree/id'
import * as tabMerge from '../../src/main/runtime/mobile-session-tab-merge'
import * as recordRows from '../../src/main/runtime/agent-session/records/agent-session-record-rows'
import type { Tab } from '../../src/shared/tab-types'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import {
  retired,
  attachWindow,
  windowFrame,
  notes,
  resultAt,
  ids
} from './structured-session-placement.test-fixture'

vi.mock('../../src/main/claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))
// The shipped layout owner: a window saves its own layout whole.
vi.mock('../../src/shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    on: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))

const chatIds = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i.toString().padStart(5, '0')}`)
async function closeRig() {
  await chatTabCommandsSettled()
  await stopStructuredAgentSessionRuntime()
  await closeTestStores()
  await closeTestJournalHostDatabases()
  vi.restoreAllMocks()
}
const linear = (tally: Record<string, number[]>) => {
  for (const [key, [small, large]] of Object.entries(tally)) {
    expect([key, large]).toEqual([key, expect.any(Number)])
    expect(large, key).toBeLessThanOrEqual(12 * Math.max(small!, 1))
  }
}

it('a window graph over N and 10N chats costs linear work to accept, resend, go stale after a move, be omitted and stay unchanged', async () => {
  const tally: Record<string, number[]> = {}
  for (const n of [20, 200]) {
    const others = chatIds('other', n)
    const listed = [B, C, ...others]
    const rig = await retired([C, ...others], listed)
    attachWindow(rig)
    rig.runtime.mobileSessionTabsByWorktree.delete(rig.old)
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    const records = vi.spyOn(rig.store, 'getRecord')
    const readability = vi.spyOn(rig.store, 'isSessionUnreadable')
    const identities = vi.spyOn(worktreeIdentity, 'worktreeIdsEqual')
    const rows = vi.spyOn(tabMerge, 'getMobileSessionSnapshotTabIdentityKeys')
    let published = 0
    rig.runtime.onMobileSessionTabsChanged(() => published++)
    const phase = (name: string, run: () => void) => {
      for (const spy of [records, readability, identities, rows]) {
        spy.mockClear()
      }
      published = 0
      run()
      for (const [key, value] of Object.entries({
        records: records.mock.calls.length,
        readability: readability.mock.calls.length,
        identities: identities.mock.calls.length,
        rows: rows.mock.calls.length,
        published
      })) {
        ;(tally[`${name}.${key}`] ??= []).push(value)
      }
    }
    const sync = rig.runtime['syncMobileSessionTabs'].bind(rig.runtime)
    phase('accept', () => sync([windowFrame(rig.old, 7, [notes], listed)]))
    phase('resend', () => {
      const resync = new Set<string>()
      sync([], [rig.old], resync)
      expect([...resync]).toEqual([])
    })
    expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
    phase('staleResend', () => {
      const resync = new Set<string>()
      sync([], [rig.old], resync)
      expect([...resync]).toEqual([rig.old])
      sync([windowFrame(rig.old, 8, [notes], listed)])
    })
    const kept = [C, ...others, notes.id].sort()
    expect(ids(resultAt(rig, rig.old))).toEqual(kept)
    // The window stops listing the workspace; the host keeps its own chat rows there.
    phase('omission', () => sync([]))
    expect(ids(resultAt(rig, rig.old))).toEqual([C, ...others].sort())
    phase('unchanged', () => sync([], [rig.old], new Set()))
    phase('outbound', () => {
      expect(ids(resultAt(rig, rig.old))).toEqual([C, ...others].sort())
    })
    await closeRig()
  }
  console.log('S3_GRAPH_COUNTS', JSON.stringify(tally))
  linear(tally)
  for (const [key, counts] of Object.entries(tally)) {
    if (key.endsWith('.published')) {
      expect(Math.max(...counts), key).toBeLessThanOrEqual(2)
    }
  }
})

it('saved get, set and patch through the real handlers filter N and 10N workspaces in linear work, and a view-only patch looks no chat up', async () => {
  const tally: Record<string, number[]> = {}
  const rig = await retired()
  expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
  const [moved] = rig.profile.getWorkspaceSession('local')!.unifiedTabs![rig.old]!
  registerSessionHandlers(rig.profile, rig.runtime)
  const records = vi.spyOn(rig.store, 'getRecord')
  const sets = vi.spyOn(rig.profile, 'setWorkspaceSession')
  const patches = vi.spyOn(rig.profile, 'patchWorkspaceSession')
  for (const n of [20, 200]) {
    // Every workspace holds the moved chat, a terminal, and another host's tab with the same IDs,
    // in a split layout whose order and selection name the moved chat.
    const workspaces = Array.from({ length: n }, (_, i) => `removed-${i}::/old/${i}`)
    const tabsOf = (workspace: string): Tab[] => [
      { ...moved!, worktreeId: workspace, groupId: `${workspace}-a` },
      { ...moved!, id: 't', entityId: 't', contentType: 'terminal', groupId: `${workspace}-b` },
      {
        ...moved!,
        worktreeId: workspace,
        groupId: `${workspace}-b`,
        executionHostId: 'runtime:other'
      }
    ]
    const stored = rig.profile.getWorkspaceSession('local')!
    const session: WorkspaceSessionState = {
      ...stored,
      unifiedTabs: Object.fromEntries(workspaces.map((w) => [w, tabsOf(w)])),
      tabGroups: Object.fromEntries(
        workspaces.map((w) => [
          w,
          [
            { id: `${w}-a`, worktreeId: w, activeTabId: moved!.id, tabOrder: [moved!.id] },
            { id: `${w}-b`, worktreeId: w, activeTabId: 't', tabOrder: ['t', moved!.id] }
          ]
        ])
      ),
      tabGroupLayouts: Object.fromEntries(
        workspaces.map((w) => [
          w,
          {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: `${w}-a` },
            second: { type: 'leaf', groupId: `${w}-b` }
          }
        ])
      ),
      activeTabIdByWorktree: Object.fromEntries(workspaces.map((w) => [w, moved!.id]))
    }
    const phase = async (name: string, run: () => unknown) => {
      for (const spy of [records, sets, patches]) {
        spy.mockClear()
      }
      await run()
      for (const [key, value] of Object.entries({
        records: records.mock.calls.length,
        sets: sets.mock.calls.length,
        patches: patches.mock.calls.length
      })) {
        ;(tally[`${name}.${key}`] ??= []).push(value)
      }
    }
    await phase('set', () => handlers.get('session:set')!({}, session, 'local'))
    const placed = rig.profile.getWorkspaceSession('local')!
    for (const workspace of workspaces) {
      // The moved chat leaves; the terminal and the other host's tab keep their places.
      expect(
        placed.unifiedTabs![workspace]!.map((tab) => [tab.contentType, tab.executionHostId])
      ).toEqual([
        ['terminal', moved!.executionHostId],
        ['agent-session', 'runtime:other']
      ])
    }
    let read: WorkspaceSessionState | undefined
    await phase('get', async () => {
      read = (await handlers.get('session:get')!({}, 'local')) as WorkspaceSessionState
    })
    expect(read!.unifiedTabs).toEqual(placed.unifiedTabs)
    await phase('patch', () =>
      handlers.get('session:patch')!({}, { unifiedTabs: session.unifiedTabs }, 'local')
    )
    expect(rig.profile.getWorkspaceSession('local')!.unifiedTabs).toEqual(placed.unifiedTabs)
    await phase('viewPatch', () =>
      handlers.get('session:patch')!({}, { activeWorktreeId: workspaces[0] }, 'local')
    )
    // A second save of the normalized result keeps it.
    await phase('resave', () => handlers.get('session:set')!({}, read, 'local'))
    expect(rig.profile.getWorkspaceSession('local')!.unifiedTabs).toEqual(placed.unifiedTabs)
  }
  console.log('S3_SAVED_COUNTS', JSON.stringify(tally))
  expect(tally['viewPatch.records']).toEqual([0, 0])
  expect(tally['get.sets']).toEqual([0, 0])
  for (const name of ['set', 'patch', 'resave']) {
    expect(tally[`${name}.${name === 'patch' ? 'patches' : 'sets'}`]).toEqual([1, 1])
  }
  linear(tally)
})

// Each population gets its own profile and journal, so the N and 10N runs are separate cases.
const rebindCatalogReads = new Map<number, Record<string, number>>()
it.each([20, 200])(
  'one rebind among %i other chats writes one record and one journal row; a repeat or an overtaken rebind writes none',
  async (n) => {
    const tally: Record<string, Record<string, number>> = {}
    const others = chatIds('other', n)
    const rig = await retired(others, others)
    // Startup settles first: it reconciles every loaded lease once, before anything is measured.
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    const writes = vi.spyOn(recordRows, 'writeAgentSessionStoreRows')
    const prepare = vi.spyOn(rig.host.deps.journalDatabase.db, 'prepare')
    const catalog = [
      vi.spyOn(rig.profile, 'getRepos'),
      vi.spyOn(rig.profile, 'getFolderWorkspaces'),
      vi.spyOn(rig.profile, 'getProjectGroups')
    ]
    const phase = async (name: string, run: () => Promise<unknown>) => {
      for (const spy of [writes, prepare, ...catalog]) {
        spy.mockClear()
      }
      await run()
      const upserts = writes.mock.calls.map(([, write]) => write.records.upsert)
      tally[name] = {
        recordWrites: upserts.filter((upsert) => upsert.length > 0).length,
        recordsWritten: upserts.reduce((sum, upsert) => sum + upsert.length, 0),
        journalUpdates: prepare.mock.calls.filter(([sql]) =>
          /^\s*UPDATE journal_sessions/i.test(sql)
        ).length,
        catalogReads: catalog.reduce((sum, spy) => sum + spy.mock.calls.length, 0)
      }
    }
    // A removal that overtakes the queued rebind leaves both addresses as they were.
    const rebind = rig.store.rebindWorkspace.bind(rig.store)
    let removal: ReturnType<typeof acquireWatcherRemovalGate> | undefined
    vi.spyOn(rig.store, 'rebindWorkspace').mockImplementationOnce(async (...args) => {
      removal = acquireWatcherRemovalGate(root)
      removal.abandonPendingInstalls()
      return rebind(...args)
    })
    await phase('overtaken', async () =>
      expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: false } })
    )
    ;(await removal)?.release()
    expect(rig.store.getRecord(B)?.location.workspaceId).toBe(rig.old)
    await phase('move', async () =>
      expect(await reveal(rig)).toMatchObject({
        ok: true,
        result: { ok: true, workspaceId: rig.destination }
      })
    )
    expect(
      rig.host.deps.journalDatabase.db
        .prepare('SELECT workspace_id FROM journal_sessions WHERE session_id = ?')
        .get(B)
    ).toMatchObject({ workspace_id: rig.destination })
    await phase('repeat', () => reveal(rig))
    expect(others.map((id) => rig.store.getRecord(id)?.location.workspaceId)).toEqual(
      others.map(() => rig.old)
    )
    console.log('S3_REBIND_COUNTS', JSON.stringify({ n, tally }))
    expect(tally.move).toMatchObject({ recordsWritten: 1, journalUpdates: 1 })
    expect(tally.overtaken).toMatchObject({ recordsWritten: 0, journalUpdates: 0 })
    expect(tally.repeat).toMatchObject({ recordsWritten: 0, journalUpdates: 0 })
    // Catalog work does not grow with the other chats.
    const reads = Object.fromEntries(
      Object.entries(tally).map(([name, counts]) => [name, counts.catalogReads!])
    )
    rebindCatalogReads.set(n, reads)
    if (n === 200) {
      expect(reads).toEqual(rebindCatalogReads.get(20) ?? reads)
    }
  }
)
