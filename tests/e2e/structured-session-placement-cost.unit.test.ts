import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import {
  root,
  B,
  C,
  reveal
} from '../../src/main/runtime/structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from '../../src/main/runtime/session-layout-apply.test-fixture'
import { acquireWatcherRemovalGate } from '../../src/main/ipc/watcher-removal-gate'
import { registerSessionHandlers } from '../../src/main/ipc/session'
import * as worktreeIdentity from '../../src/shared/worktree/id'
import * as tabMerge from '../../src/main/runtime/mobile-session-tab-merge'
import * as recordRows from '../../src/main/runtime/agent-session/records/agent-session-record-rows'
import * as storeDraft from '../../src/main/runtime/agent-session/records/agent-session-store-draft'
import * as attribution from '../../src/main/runtime/agent-session/agent-session-runtime-attribution'
import { sessionCrewChanges } from '../../src/main/runtime/orchestration/crew/crew-changes'
import { StructuredAgentSessionHostRuntimeState } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-runtime-state'
import { storeRepo } from '../../src/main/runtime/runtime-store-partial-fixture'
import type { Tab } from '../../src/shared/tab-types'
import { ProfileStateSqliteAuthority } from '../../src/main/persistence/profile-state/profile-state-sqlite-authority'
import type { ProfileStateDomainReplacement } from '../../src/main/persistence/loading-store/profile-state-authority'
import * as placement from '../../src/main/runtime/session-tabs/structured-session-placement'
import * as tabFilter from '../../src/shared/workspace-session-tab-filter'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../src/shared/runtime-types'
import { collectionVisits, fieldReads } from '../../src/main/runtime/collection-visits.test-fixture'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import {
  retired,
  attachWindow,
  windowFrame,
  notes,
  resultAt,
  ids,
  recordQueries
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
// Per-phase budget for the graph contract: visits/lookups per listed chat, plus a fixed cost.
const GRAPH_PER_CHAT = 40
const GRAPH_FIXED = 400
// Projections or frame merges of one workspace per graph phase.
const GRAPH_PASSES = 4
// The per-workspace maps the saved-tab filter reads or rebuilds.
const OWNER_MAPS = [
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'activeGroupIdByWorktree',
  'activeTabIdByWorktree',
  'activeTabTypeByWorktree'
] as const
const linear = (tally: Record<string, number[]>) => {
  for (const [key, [small, large]] of Object.entries(tally)) {
    expect([key, large]).toEqual([key, expect.any(Number)])
    expect(large, key).toBeLessThanOrEqual(12 * Math.max(small!, 1))
  }
}

// Each population gets its own profile and journal, so the N and 10N runs are separate cases.
const graphTally: Record<string, number[]> = {}
it.each([20, 200])(
  'a window graph over %i chats adds work additive in its input to accept, resend, go stale after a move, be omitted and stay unchanged',
  async (n) => {
    const tally = graphTally
    const others = chatIds('other', n)
    const listed = [B, C, ...others]
    // N unrelated readable chats elsewhere, which no graph or query here names.
    const rig = await retired([C, ...others], listed, { unrelated: chatIds('unrelated', n) })
    attachWindow(rig)
    rig.runtime.mobileSessionTabsByWorktree.delete(rig.old)
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    const identities = vi.spyOn(worktreeIdentity, 'worktreeIdsEqual')
    const rows = vi.spyOn(tabMerge, 'getMobileSessionSnapshotTabIdentityKeys')
    // One subscriber, as one phone: what each settled notification delivers.
    const delivered = { notifications: 0, elements: 0, bytes: 0 }
    rig.runtime.onMobileSessionTabsChanged((result) => {
      delivered.notifications++
      delivered.elements +=
        result.tabs.length + result.tabGroups.reduce((sum, group) => sum + group.tabOrder.length, 0)
      delivered.bytes += JSON.stringify(result).length
    })
    // The window's own frame, its chat order split across groups of ten.
    const frame = (version: number) => {
      const whole = windowFrame(rig.old, version, [notes], listed)
      const order = whole.tabGroups[0]!.tabOrder
      return {
        ...whole,
        tabGroups: Array.from({ length: Math.ceil(order.length / 10) }, (_, i) => ({
          id: `window-group-${i}`,
          activeTabId: null,
          tabOrder: order.slice(i * 10, i * 10 + 10)
        }))
      }
    }
    // Two unchanged main costs, counted apart and reported but outside the bound on the work this
    // change adds (byte-identical to main): each chat tab's title searches the workspace's saved
    // tabs (prune-mobile-session-tab-group-layout.ts:119), and merging a frame searches every
    // group's order once per chat (mobile-session-tab-merge.ts:209). Both read N² entries for N
    // chats in one workspace, so this graph as a whole is not linear. What is bounded instead is
    // how often their callers run and how much input they get: a fixed number of passes per phase.
    const inherited = {
      titleVisits: 0,
      chatOrderVisits: 0,
      projections: 0,
      projectedTabs: 0,
      chatOrderMerges: 0,
      chatOrderInput: 0
    }
    const title = rig.runtime['structuredConversationTabName'].bind(rig.runtime)
    Object.defineProperty(rig.runtime, 'structuredConversationTabName', {
      value: (workspaceId: string, sessionId: string) => {
        const named = collectionVisits(() => title(workspaceId, sessionId))
        inherited.titleVisits += named.visits
        return named.value
      }
    })
    const project = rig.runtime['toMobileSessionTabsResult'].bind(rig.runtime)
    Object.defineProperty(rig.runtime, 'toMobileSessionTabsResult', {
      value: (snapshot: RuntimeMobileSessionTabsSnapshot) => {
        inherited.projections++
        inherited.projectedTabs += snapshot.tabs.length
        return project(snapshot)
      }
    })
    const order = tabMerge.appendChatTabOrder
    vi.spyOn(tabMerge, 'appendChatTabOrder').mockImplementation((groups, prior, tabs, active) => {
      const orders = (list: typeof groups | undefined) =>
        (list ?? []).reduce((sum, group) => sum + group.tabOrder.length, 0)
      inherited.chatOrderMerges++
      inherited.chatOrderInput += orders(groups) + orders(prior) + tabs.length
      const ordered = collectionVisits(() => order(groups, prior, tabs, active))
      inherited.chatOrderVisits += ordered.visits
      return ordered.value
    })
    // The real graph entry point; the keyed coalescer then delivers what it scheduled.
    const graph = (
      mobileSessionTabs: RuntimeMobileSessionTabsSnapshot[],
      unchangedMobileSessionWorktrees: string[] = []
    ) =>
      rig.runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs,
        unchangedMobileSessionWorktrees
      }).mobileSessionResyncWorktrees ?? []
    const phase = (name: string, run: () => string[]) => {
      identities.mockClear()
      rows.mockClear()
      Object.assign(delivered, { notifications: 0, elements: 0, bytes: 0 })
      for (const key of Object.keys(inherited) as (keyof typeof inherited)[]) {
        inherited[key] = 0
      }
      const records = recordQueries(rig.store)
      const synced = collectionVisits(run)
      const published = collectionVisits(() =>
        rig.runtime['mobileSessionTabsNotifyCoalescer'].flushAll()
      )
      records.restore()
      for (const [key, value] of Object.entries({
        recordLookups: records.counts.lookups,
        recordsEnumerated: records.counts.enumerated,
        syncVisits: synced.visits,
        syncLookups: synced.lookups,
        identities: identities.mock.calls.length,
        rows: rows.mock.calls.length,
        publishVisits: published.visits,
        ...delivered,
        ...inherited
      })) {
        ;(tally[`${name}.${key}`] ??= []).push(value)
      }
      return synced.value
    }
    expect(phase('accept', () => graph([frame(7)]))).toEqual([])
    expect(phase('resend', () => graph([], [rig.old]))).toEqual([])
    expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
    expect(phase('staleResend', () => graph([], [rig.old]))).toEqual([rig.old])
    expect(phase('staleFrame', () => graph([frame(8)]))).toEqual([])
    const kept = [C, ...others, notes.id].sort()
    expect(ids(resultAt(rig, rig.old))).toEqual(kept)
    // The window stops listing the workspace; the host keeps its own chat rows there.
    expect(phase('omission', () => graph([]))).toEqual([])
    expect(ids(resultAt(rig, rig.old))).toEqual([C, ...others].sort())
    // "Unchanged" for a workspace the window last omitted asks it for a whole frame again.
    expect(phase('unchanged', () => graph([], [rig.old]))).toEqual([rig.old])
    let outbound: RuntimeMobileSessionTabsResult | undefined
    phase('outbound', () => {
      outbound = resultAt(rig, rig.old)
      return []
    })
    expect(ids(outbound)).toEqual([C, ...others].sort())
    for (const [key, counts] of Object.entries(tally)) {
      const at = counts.length - 1
      // Settled delivery follows the one workspace that changed, never the chat count.
      if (key.endsWith('.notifications')) {
        expect(counts[at], key).toBeLessThanOrEqual(1)
      }
      // No placement query enumerates the stored records, related or not.
      if (key.endsWith('.recordsEnumerated')) {
        expect(counts[at], key).toBe(0)
      }
      // A fixed cost plus a few visits or lookups per listed chat in each phase.
      if (/\.(syncVisits|syncLookups|publishVisits|recordLookups)$/.test(key)) {
        expect(counts[at], key).toBeLessThanOrEqual(GRAPH_PER_CHAT * listed.length + GRAPH_FIXED)
      }
      // The main-cost callers run a fixed number of times per phase, each over about the
      // workspace's own rows: never once per chat, never on inflated input.
      if (/\.(projections|chatOrderMerges)$/.test(key)) {
        expect(counts[at], key).toBeLessThanOrEqual(GRAPH_PASSES)
      }
      if (/\.(projectedTabs|chatOrderInput)$/.test(key)) {
        expect(counts[at], key).toBeLessThanOrEqual(GRAPH_PASSES * 3 * (listed.length + 2))
      }
    }
    if (n === 200) {
      console.log('S3_GRAPH_COUNTS', JSON.stringify(tally))
      // The 20-chat case runs first in this file and leaves its counts beside these.
      expect(Object.values(tally).every((counts) => counts.length === 2)).toBe(true)
      // Reported, not bounded here: the inherited searches above.
      linear(
        Object.fromEntries(
          Object.entries(tally).filter(([key]) => !/\.(titleVisits|chatOrderVisits)$/.test(key))
        )
      )
    }
  }
)

it('saved get, set and patch through the real handlers filter N and 10N workspaces in linear work, and a view-only patch looks no chat up', async () => {
  const tally: Record<string, number[]> = {}
  const rig = await retired()
  expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
  const [moved] = rig.profile.getWorkspaceSession('local')!.unifiedTabs![rig.old]!
  registerSessionHandlers(rig.profile, rig.runtime)
  const sets = vi.spyOn(rig.profile, 'setWorkspaceSession')
  const patches = vi.spyOn(rig.profile, 'patchWorkspaceSession')
  // What reaches the profile database through flush, and the writes it announces.
  const written = { domains: 0, bytes: 0, notified: 0 }
  for (const name of ['writeSerializedDomains', 'writeCompleteSerializedDomains'] as const) {
    const write = ProfileStateSqliteAuthority.prototype[name]
    vi.spyOn(ProfileStateSqliteAuthority.prototype, name).mockImplementation(function (
      this: ProfileStateSqliteAuthority,
      replacements: readonly ProfileStateDomainReplacement[],
      ...rest: never[]
    ) {
      written.domains += replacements.length
      written.bytes += replacements.reduce((sum, entry) => sum + (entry.payload?.length ?? 0), 0)
      return write.call(this, replacements, ...rest)
    })
  }
  rig.profile.onStateWritten(() => written.notified++)
  const placements = vi.spyOn(placement, 'structuredSessionPlacementAllowed')
  // The pure filter the handlers run, on its real input: the owner-map keys and tree-node fields
  // it reads (a spread reads every key), and what it returns, for identity checks.
  const filtered: { input: WorkspaceSessionState; output: WorkspaceSessionState }[] = []
  const filterReads = { ownerKeys: 0, ownerKeyReads: 0, treeNodes: 0, treeNodeReads: 0 }
  const filter = tabFilter.filterWorkspaceSessionTabs
  vi.spyOn(tabFilter, 'filterWorkspaceSessionTabs').mockImplementation((input, keep) => {
    // Watching and unwatching are this test's work: a nested measurement keeps them out of the
    // handler's own counts.
    const { value: watching } = collectionVisits(() => {
      const owners = fieldReads()
      const trees = fieldReads()
      for (const tree of Object.values(input.tabGroupLayouts ?? {})) {
        filterReads.treeNodes += trees.watchTree(tree)
      }
      for (const name of OWNER_MAPS) {
        const map: Record<string, unknown> | undefined = input[name]
        if (map) {
          filterReads.ownerKeys += Object.keys(map).length
          owners.watch(map)
        }
      }
      return { owners, trees }
    })
    try {
      const output = filter(input, keep)
      filtered.push({ input, output })
      return output
    } finally {
      collectionVisits(() => {
        filterReads.ownerKeyReads += watching.owners.reads()
        filterReads.treeNodeReads += watching.trees.reads()
        watching.owners.restore()
        watching.trees.restore()
      })
    }
  })
  for (const n of [20, 200]) {
    // N workspaces hold the moved chat, a terminal, an editor and another host's tab with the same
    // ID, in a nested split whose order, selection and recent tabs name the moved chat; N more
    // hold only a terminal and an editor, which no filtering should touch.
    const workspaces = Array.from({ length: n }, (_, i) => `removed-${i}::/old/${i}`)
    const unaffected = Array.from({ length: n }, (_, i) => `kept-${i}::/kept/${i}`)
    const row = (
      workspace: string,
      id: string,
      contentType: Tab['contentType'],
      group: string
    ) => ({
      ...moved!,
      id,
      entityId: id,
      contentType,
      worktreeId: workspace,
      groupId: `${workspace}-${group}`
    })
    const tabsOf = (workspace: string): Tab[] =>
      workspace.startsWith('kept-')
        ? [row(workspace, 't', 'terminal', 'b'), row(workspace, 'e', 'editor', 'c')]
        : [
            { ...moved!, worktreeId: workspace, groupId: `${workspace}-a` },
            row(workspace, 't', 'terminal', 'b'),
            ...(twin(workspace)
              ? [
                  {
                    ...moved!,
                    worktreeId: workspace,
                    groupId: `${workspace}-b`,
                    executionHostId: 'runtime:other'
                  }
                ]
              : []),
            row(workspace, 'e', 'editor', 'c')
          ]
    const groupsOf = (w: string) =>
      w.startsWith('kept-')
        ? [
            { id: `${w}-b`, worktreeId: w, activeTabId: 't', tabOrder: ['t'], recentTabIds: ['t'] },
            { id: `${w}-c`, worktreeId: w, activeTabId: 'e', tabOrder: ['e'], recentTabIds: ['e'] }
          ]
        : [
            {
              id: `${w}-a`,
              worktreeId: w,
              activeTabId: moved!.id,
              tabOrder: [moved!.id],
              recentTabIds: [moved!.id]
            },
            {
              id: `${w}-b`,
              worktreeId: w,
              activeTabId: 't',
              tabOrder: ['t', moved!.id],
              recentTabIds: [moved!.id, 't']
            },
            { id: `${w}-c`, worktreeId: w, activeTabId: 'e', tabOrder: ['e'], recentTabIds: ['e'] }
          ]
    const treeOf = (w: string) =>
      w.startsWith('kept-')
        ? {
            type: 'split' as const,
            direction: 'vertical' as const,
            first: { type: 'leaf' as const, groupId: `${w}-b` },
            second: { type: 'leaf' as const, groupId: `${w}-c` }
          }
        : {
            type: 'split' as const,
            direction: 'horizontal' as const,
            first: { type: 'leaf' as const, groupId: `${w}-a` },
            second: {
              type: 'split' as const,
              direction: 'vertical' as const,
              first: { type: 'leaf' as const, groupId: `${w}-b` },
              second: { type: 'leaf' as const, groupId: `${w}-c` }
            }
          }
    const all = [...workspaces, ...unaffected]
    // Half the moved chat's workspaces also hold another host's tab with its ID, which keeps every
    // reference to that ID; in the rest its order, recent-tab, tree and focus references go.
    const twin = (workspace: string) => workspaces.indexOf(workspace) % 2 === 0
    const stored = rig.profile.getWorkspaceSession('local')!
    const session: WorkspaceSessionState = {
      ...stored,
      unifiedTabs: Object.fromEntries(all.map((w) => [w, tabsOf(w)])),
      tabGroups: Object.fromEntries(all.map((w) => [w, groupsOf(w)])),
      tabGroupLayouts: Object.fromEntries(all.map((w) => [w, treeOf(w)])),
      activeTabIdByWorktree: Object.fromEntries(all.map((w) => [w, moved!.id]))
    }
    const phase = async (name: string, run: () => unknown) => {
      // Earlier writes settle first, so each phase reports only its own.
      await rig.profile.flushPendingOrThrowAsync()
      for (const spy of [sets, patches, placements]) {
        spy.mockClear()
      }
      Object.assign(written, { domains: 0, bytes: 0, notified: 0 })
      Object.assign(filterReads, { ownerKeys: 0, ownerKeyReads: 0, treeNodes: 0, treeNodeReads: 0 })
      filtered.length = 0
      const records = recordQueries(rig.store)
      const handled = collectionVisits(run)
      records.restore()
      const value = await handled.value
      await rig.profile.flushPendingOrThrowAsync()
      for (const [key, value] of Object.entries({
        recordLookups: records.counts.lookups,
        recordsEnumerated: records.counts.enumerated,
        visits: handled.visits,
        lookups: handled.lookups,
        placements: placements.mock.calls.length,
        sets: sets.mock.calls.length,
        patches: patches.mock.calls.length,
        filterCalls: filtered.length,
        ...filterReads,
        ...written
      })) {
        ;(tally[`${name}.${key}`] ??= []).push(value)
      }
      return value
    }
    await phase('set', () => handlers.get('session:set')!({}, session, 'local'))
    const placed = rig.profile.getWorkspaceSession('local')!
    for (const workspace of workspaces) {
      // The moved chat leaves; the terminal, the editor and the other host's tab keep their places.
      expect(
        placed.unifiedTabs![workspace]!.map((tab) => [tab.id, tab.contentType, tab.executionHostId])
      ).toEqual([
        ['t', 'terminal', moved!.executionHostId],
        ...(twin(workspace) ? [[moved!.id, 'agent-session', 'runtime:other']] : []),
        ['e', 'editor', moved!.executionHostId]
      ])
      const [, b, c] = groupsOf(workspace)
      expect(placed.tabGroups[workspace]).toEqual(
        twin(workspace) ? groupsOf(workspace) : [{ ...b, tabOrder: ['t'], recentTabIds: ['t'] }, c]
      )
      expect(placed.tabGroupLayouts?.[workspace]).toEqual(
        twin(workspace) ? treeOf(workspace) : treeOf(workspace).second
      )
      expect(placed.activeTabIdByWorktree?.[workspace]).toBe(
        twin(workspace) ? moved!.id : undefined
      )
    }
    // The filter keeps what it does not change: unaffected owners' arrays and trees, and the
    // other host's rows, are its input's own objects.
    const { input: unfiltered, output: kept } = filtered.at(-1)!
    for (const workspace of unaffected) {
      expect(kept.unifiedTabs[workspace]).toBe(unfiltered.unifiedTabs[workspace])
      expect(kept.tabGroups?.[workspace]).toBe(unfiltered.tabGroups?.[workspace])
      expect(kept.tabGroupLayouts?.[workspace]).toBe(unfiltered.tabGroupLayouts?.[workspace])
    }
    for (const workspace of workspaces.filter(twin)) {
      const foreign = (state: WorkspaceSessionState) =>
        state.unifiedTabs[workspace]?.find((tab) => tab.executionHostId === 'runtime:other')
      expect(foreign(kept)).toBe(foreign(unfiltered))
    }
    // After the store, the saved values match.
    for (const workspace of unaffected) {
      expect(placed.unifiedTabs[workspace]).toEqual(session.unifiedTabs[workspace])
      expect(placed.tabGroups[workspace]).toEqual(session.tabGroups[workspace])
      expect(placed.tabGroupLayouts?.[workspace]).toEqual(session.tabGroupLayouts?.[workspace])
    }
    const read = (await phase('get', () =>
      handlers.get('session:get')!({}, 'local')
    )) as WorkspaceSessionState
    expect(read.unifiedTabs).toEqual(placed.unifiedTabs)
    await phase('patch', () =>
      handlers.get('session:patch')!({}, { unifiedTabs: session.unifiedTabs }, 'local')
    )
    expect(rig.profile.getWorkspaceSession('local')!.unifiedTabs).toEqual(placed.unifiedTabs)
    await phase('viewPatch', () =>
      handlers.get('session:patch')!({}, { activeWorktreeId: workspaces[0] }, 'local')
    )
    // A second save of the normalized result keeps it.
    await phase('resave', () => handlers.get('session:set')!({}, read, 'local'))
    // Nothing left to remove: the filter returns its input itself.
    expect(filtered.at(-1)!.output).toBe(filtered.at(-1)!.input)
    expect(rig.profile.getWorkspaceSession('local')!.unifiedTabs).toEqual(placed.unifiedTabs)
  }
  console.log('S3_SAVED_COUNTS', JSON.stringify(tally))
  // A view-only patch asks no placement, and reads the records no more at 10N.
  expect(tally['viewPatch.placements']).toEqual([0, 0])
  expect(tally['viewPatch.recordLookups']![1]).toBe(tally['viewPatch.recordLookups']![0])
  expect(tally['get.sets']).toEqual([0, 0])
  expect(tally['get.domains']).toEqual([0, 0])
  expect(tally['get.notified']).toEqual([0, 0])
  for (const name of ['set', 'patch', 'resave']) {
    expect(tally[`${name}.${name === 'patch' ? 'patches' : 'sets'}`]).toEqual([1, 1])
  }
  // Per phase, for W = 2N workspaces of a few tabs and groups each: one placement per moved row,
  // two record lookups per moved row, a fixed number of visits and lookups per workspace, and at
  // most one database write and one write notice.
  for (const [key, counts] of Object.entries(tally)) {
    const phase = key.slice(0, key.indexOf('.'))
    for (const [i, n] of [20, 200].entries()) {
      // Through the filter: each owner-map key and tree node read a fixed number of times.
      const input = (name: string) => tally[`${phase}.${name}`]![i]!
      const bound = key.endsWith('.ownerKeyReads')
        ? 2 * input('ownerKeys') + 8
        : key.endsWith('.treeNodeReads')
          ? 3 * input('treeNodes') + 8
          : key.endsWith('.filterCalls')
            ? 1
            : key.endsWith('.placements')
              ? n
              : key.endsWith('.recordLookups')
                ? 2 * n + 8
                : key.endsWith('.visits')
                  ? 40 * 2 * n + 200
                  : key.endsWith('.lookups')
                    ? 15 * 2 * n + 50
                    : key.endsWith('.domains') || key.endsWith('.notified')
                      ? 1
                      : Infinity
      expect(counts[i], key).toBeLessThanOrEqual(bound)
    }
  }
  linear(tally)
})

// Each population gets its own profile and journal, so the N and 10N runs are separate cases.
const rebindTally: Record<string, number[]> = {}
it.each([20, 200])(
  'one rebind among %i other chats writes one record and one journal row; a repeat or an overtaken rebind writes none',
  async (n) => {
    const tally: Record<string, Record<string, number>> = {}
    // V visible chats in the old workspace, H unrelated chats elsewhere and A finished replies.
    const others = chatIds('other', n)
    const rig = await retired(others, others, { unrelated: chatIds('unrelated', n), completed: n })
    // A populated catalog: N folder projects and N folder workspaces, none at the chat's directory.
    const group = rig.profile.createProjectGroup({
      name: 'Elsewhere',
      parentPath: `${root}-elsewhere`,
      connectionId: null,
      parentGroupId: null,
      createdFrom: 'manual'
    })
    for (let i = 0; i < n; i++) {
      rig.profile.addRepo(
        storeRepo({ id: `elsewhere-${i}`, path: `${root}-elsewhere/r${i}`, kind: 'folder' })
      )
      rig.profile.createFolderWorkspace({
        projectGroupId: group.id,
        folderPath: `${root}-elsewhere/f${i}`,
        name: `Elsewhere ${i}`
      })
    }
    // Startup settles first: it reconciles every loaded lease once, before anything is measured.
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    const work: Record<string, number> = {}
    const add = (key: string, count: number) => (work[key] = (work[key] ?? 0) + count)
    // Catalog rows read, while the reveal prepares and while its receipt admits the destination.
    let stage: 'prepare' | 'admission' = 'prepare'
    for (const name of ['getRepos', 'getFolderWorkspaces', 'getProjectGroups'] as const) {
      const read = rig.profile[name].bind(rig.profile) as () => unknown[]
      vi.spyOn(rig.profile, name).mockImplementation(
        (() =>
          new Proxy(read(), {
            get: (rows, key) => {
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                add(`${stage}CatalogRows`, 1)
              }
              return rows[key as keyof typeof rows]
            }
          })) as never
      )
    }
    const rebind = rig.store.rebindWorkspace.bind(rig.store)
    let removal: ReturnType<typeof acquireWatcherRemovalGate> | undefined
    let overtake = true
    vi.spyOn(rig.store, 'rebindWorkspace').mockImplementation(
      (sessionId, original, location, check) => {
        // A removal that overtakes the first queued rebind leaves both addresses as they were.
        if (overtake) {
          overtake = false
          removal = acquireWatcherRemovalGate(root)
          removal.abandonPendingInstalls()
        }
        // The receipt's commit-time proof: the catalog read while admitting the destination.
        return rebind(sessionId, original, location, (record) => {
          stage = 'admission'
          try {
            check(record)
          } finally {
            stage = 'prepare'
          }
        })
      }
    )
    // The receipt's own collection work: draft copy, runtime attribution and the row diff.
    for (const [module, name, key] of [
      [storeDraft, 'draftAgentSessionStoreState', 'draftCopy'],
      [attribution, 'attributeAgentSessionRuntime', 'attribution'],
      [storeDraft, 'agentSessionStoreDraftRowWrites', 'diff']
    ] as const) {
      const original = (module as Record<string, (...args: never[]) => unknown>)[name]!
      vi.spyOn(module as never, name as never).mockImplementation(((...args: never[]) => {
        const counted = collectionVisits(() => original(...args))
        add(`${key}Visits`, counted.visits)
        add(`${key}Lookups`, counted.lookups)
        return counted.value
      }) as never)
    }
    const writes = vi.spyOn(recordRows, 'writeAgentSessionStoreRows')
    // Journal statements as executed, with their bindings.
    const prepare = rig.host.deps.journalDatabase.db.prepare.bind(rig.host.deps.journalDatabase.db)
    vi.spyOn(rig.host.deps.journalDatabase.db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql)
      if (/^\s*UPDATE journal_sessions/i.test(sql)) {
        const run = statement.run.bind(statement)
        vi.spyOn(statement, 'run').mockImplementation((...bindings) => {
          add('journalUpdates', 1)
          add('journalBindings', bindings.length)
          return run(...bindings)
        })
      }
      return statement
    })
    // Every owner probe this host starts, with the chat it probes: a released, settled population
    // gives the receipt nothing to probe, the moved chat or any other.
    const probed: string[] = []
    const probe = StructuredAgentSessionHostRuntimeState.prototype.probeRecord
    vi.spyOn(StructuredAgentSessionHostRuntimeState.prototype, 'probeRecord').mockImplementation(
      function (this: StructuredAgentSessionHostRuntimeState, record) {
        probed.push(record.sessionId)
        return probe.call(this, record)
      }
    )
    const unsubscribe = sessionCrewChanges.subscribe((facets) =>
      add(facets.has('records') ? 'topologyNotices' : 'otherNotices', 1)
    )
    const phase = async (name: string, run: () => Promise<unknown>) => {
      writes.mockClear()
      probed.length = 0
      for (const key of Object.keys(work)) {
        work[key] = 0
      }
      await run()
      const rows = writes.mock.calls.map(([, write]) => write)
      tally[name] = {
        ...work,
        ownerProbes: probed.length,
        unrelatedProbes: probed.filter((sessionId) => sessionId !== B).length,
        recordsWritten: rows.reduce((sum, write) => sum + write.records.upsert.length, 0),
        recordsRemoved: rows.reduce((sum, write) => sum + write.records.remove.length, 0),
        operationsWritten: rows.reduce((sum, write) => sum + write.operations.upsert.length, 0),
        operationsRemoved: rows.reduce((sum, write) => sum + write.operations.remove.length, 0),
        encodedBytes: rows.reduce(
          (sum, write) =>
            sum +
            [...write.records.upsert, ...write.operations.upsert].reduce(
              (bytes, [, json]) => bytes + json.length,
              0
            ),
          0
        )
      }
    }
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
    unsubscribe()
    expect(others.map((id) => rig.store.getRecord(id)?.location.workspaceId)).toEqual(
      others.map(() => rig.old)
    )
    console.log('S3_REBIND_COUNTS', JSON.stringify({ n, tally }))
    expect(tally.move).toMatchObject({
      recordsWritten: 1,
      recordsRemoved: 0,
      operationsWritten: 0,
      operationsRemoved: 0,
      journalUpdates: 1,
      journalBindings: 2,
      // The moved record's commit and its placement's follow-up, at any N.
      topologyNotices: 2
    })
    for (const counts of Object.values(tally)) {
      expect(counts).toMatchObject({ ownerProbes: 0, unrelatedProbes: 0 })
    }
    for (const name of ['overtaken', 'repeat']) {
      expect(tally[name], name).toMatchObject({ recordsWritten: 0, operationsWritten: 0 })
      expect(tally[name]!.journalUpdates ?? 0, name).toBe(0)
    }
    // Per phase: catalog reads a fixed number of passes over its 2N + 3 rows, never per stored
    // chat or reply; the receipt's copy, attribution and diff a fixed number of passes over the
    // H + V records, A replies and V visible tabs.
    const stored = 3 * n + 4
    for (const [name, counts] of Object.entries(tally)) {
      for (const [key, value] of Object.entries(counts)) {
        ;(rebindTally[`${name}.${key}`] ??= []).push(value)
      }
      for (const stage of ['prepare', 'admission']) {
        expect(counts[`${stage}CatalogRows`] ?? 0, `${name}.${stage}`).toBeLessThanOrEqual(
          24 * (2 * n + 3) + 100
        )
      }
      for (const key of ['draftCopy', 'attribution', 'diff']) {
        expect(counts[`${key}Visits`] ?? 0, `${name}.${key}`).toBeLessThanOrEqual(10 * stored + 50)
      }
    }
    if (n === 200) {
      // The 20-chat case runs first in this file and leaves its counts beside these.
      linear(
        Object.fromEntries(Object.entries(rebindTally).filter(([, counts]) => counts.length === 2))
      )
    }
  }
)
