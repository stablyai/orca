import { afterEach, expect, it, vi } from 'vitest'
import type * as ChatTabLayoutQueueModule from '../../src/main/runtime/agent-session-tab-layout-queue'
import type { RuntimeMobileSessionTabsSnapshot } from '../../src/shared/runtime-types'
import {
  authorityProfile,
  openAuthorityRuntime
} from '../../src/main/runtime/structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from '../../src/main/runtime/session-layout-apply.test-fixture'
import { createChatTabLayoutQueue } from '../../src/main/runtime/agent-session-tab-layout-queue'
import { applyWindowLayoutCommand } from '../../src/main/runtime/runtime-layout-apply'
import { fixture } from '../../src/main/persistence/loading-store/profile-state-delayed-authority-fixture'
import {
  loadChatTabLayout,
  withChatTabChanges
} from '../../src/main/runtime/agent-session/agent-session-tab-layout'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'

const queueProbe = vi.hoisted(() => {
  const queues: Pick<ReturnType<typeof createChatTabLayoutQueue>, 'pendingOpens'>[] = []
  return {
    enabled: false,
    copies: 0,
    visits: 0,
    queues
  }
})
vi.mock('../../src/main/runtime/agent-session-tab-layout-queue', async (original) => {
  const module = await original<typeof ChatTabLayoutQueueModule>()
  return {
    ...module,
    createChatTabLayoutQueue: (...args: Parameters<typeof module.createChatTabLayoutQueue>) => {
      const queue = module.createChatTabLayoutQueue(...args)
      if (queueProbe.enabled) {
        queueProbe.queues.push(queue)
        const pending = queue.pendingOpens
        queue.pendingOpens = () => {
          const rows = pending()
          queueProbe.copies += rows.length
          for (const [index, row] of rows.entries()) {
            Object.defineProperty(rows, index, {
              get: () => {
                queueProbe.visits++
                return row
              }
            })
          }
          return rows
        }
      }
      return queue
    }
  }
})
afterEach(() => {
  queueProbe.enabled = false
  queueProbe.queues = []
  layoutOwner.main = false
})

const layoutOwner = vi.hoisted(() => ({ main: false }))
vi.mock('../../src/shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.main
  }
}))

vi.mock('../../src/main/claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))

it.each([10, 100])(
  'counts real raw stores, unrelated window publications and captured cleanup at %i chats',
  async (n) => {
    const ids = Array.from({ length: n }, (_, i) => `selected-${i.toString().padStart(5, '0')}`)
    const rig = await openAuthorityRuntime(await authorityProfile(ids, { visible: ids }))
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    const original = rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)!
    const lookup = vi.spyOn(rig.store, 'getSessionTabId')
    const record = vi.spyOn(rig.store, 'getConversation')
    const journal = vi.spyOn(rig.store, 'transitionHandoff')
    let orderVisits = 0
    const countedOrder = original.tabs.map((tab) => tab.id)
    for (const [index, id] of countedOrder.entries()) {
      Object.defineProperty(countedOrder, index, {
        get: () => {
          orderVisits++
          return id
        }
      })
    }
    const raw = {
      ...original,
      tabGroups: [{ id: 'counted', activeTabId: null, tabOrder: countedOrder }]
    }
    rig.runtime.storeMobileSessionSnapshot(rig.workspace, raw)
    expect(lookup).toHaveBeenCalledTimes(n)
    expect(orderVisits).toBe(n)
    expect(record).not.toHaveBeenCalled()
    lookup.mockClear()
    orderVisits = 0
    rig.runtime.attachWindow(1)
    rig.runtime.markGraphReady(1)
    rig.runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [{ ...raw, publicationEpoch: 'cost-window', snapshotVersion: 1 }]
    })
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(3 * n)
    expect(orderVisits).toBeLessThanOrEqual(6 * n)
    lookup.mockClear()
    record.mockClear()
    // An unrelated terminal-only snapshot still traverses the real identity normalization seam.
    rig.runtime.storeMobileSessionSnapshot('unrelated', {
      ...raw,
      worktree: 'unrelated',
      tabs: [
        {
          type: 'terminal',
          id: 'term-tab::00000000-0000-4000-8000-000000000001',
          parentTabId: 'term-tab',
          leafId: '00000000-0000-4000-8000-000000000001',
          title: 'terminal',
          isActive: false
        }
      ]
    })
    expect(lookup).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
    const saved = rig.profile.getWorkspaceSession().unifiedTabs?.[rig.workspace] ?? []
    let savedVisits = 0
    for (const tab of saved) {
      const entityId = tab.entityId
      Object.defineProperty(tab, 'entityId', {
        get: () => {
          savedVisits++
          return entityId
        },
        configurable: true
      })
    }
    const { closeStructuredAgentSessionChild } =
      await import('../../src/main/runtime/agent-session/structured-agent-session-close')
    await closeStructuredAgentSessionChild(ids[0]!, { runtime: rig.runtime })
    await chatTabCommandsSettled()
    expect(savedVisits).toBeLessThanOrEqual(8 * n)
    expect(journal).not.toHaveBeenCalled()
    expect(rig.acquire).not.toHaveBeenCalled()
  }
)

it.each([10, 100])(
  'bounds actual queued profile replacement to two steps at %i saved rows in both directions',
  async (n) => {
    const { store, authority } = await fixture()
    const workspace = 'replacement-cost'
    const initial = withChatTabChanges(
      'local',
      getDefaultWorkspaceSession(),
      workspace,
      Array.from({ length: n }, (_, index) => ({
        open: { sessionId: `session-${index}`, agent: 'codex', tabId: `legacy-${index}` }
      }))
    )
    if (!initial) {
      throw new Error('fixture must have saved rows')
    }
    store.setWorkspaceSession(initial)
    await store.flushPendingOrThrowAsync()
    let loads = 0,
      applies = 0
    let applied: Promise<unknown> = Promise.resolve()
    const queue = createChatTabLayoutQueue({
      sessionOf: () => {
        loads++
        return store.getWorkspaceSession()
      },
      hostIdOf: () => 'local',
      apply: (command, run) => {
        applies++
        const result = applyWindowLayoutCommand(store, () => ['local'], command, undefined, run)
        applied = result
        return result
      }
    })
    for (const tabId of ['agent-chat-tab-v1-first', 'agent-chat-tab-v1-next', 'legacy-0']) {
      loads = 0
      applies = 0
      authority.captures.length = 0
      queue(() => [
        {
          worktreeId: workspace,
          change: { open: { sessionId: 'session-0', agent: 'codex', tabId } },
          eligible: () => true
        }
      ])
      await vi.waitFor(() =>
        expect(
          store
            .getWorkspaceSession()
            .unifiedTabs?.[workspace]?.find((tab) => tab.entityId === 'session-0')?.id
        ).toBe(tabId)
      )
      await applied
      expect(applies).toBe(2)
      expect(loads).toBe(4)
      expect(authority.captures).toHaveLength(2)
    }
    applies = 0
    loads = 0
    authority.captures.length = 0
    queue(() => [{ worktreeId: workspace, change: { close: 'session-0', tabId: 'legacy-0' } }])
    await vi.waitFor(() =>
      expect(
        store
          .getWorkspaceSession()
          .unifiedTabs?.[workspace]?.some((tab) => tab.entityId === 'session-0')
      ).toBe(false)
    )
    await applied
    expect(applies).toBe(1)
    expect(loads).toBe(2)
    expect(authority.captures).toHaveLength(1)
  }
)

it.each([10, 100])(
  'publishes actual renderer mappings through the window graph in order at %i chats with linear trigger work',
  async (n) => {
    const { buildMobileSessionTabSnapshots } =
      await import('../../src/renderer/src/runtime/sync-runtime-graph/mobile-session-snapshots')
    const { makeState } =
      await import('../../src/renderer/src/runtime/sync-runtime-graph-test-harness')
    const mappings =
      await import('../../src/renderer/src/runtime/web-session-tabs-sync/tracking-mappings')
    const { hostSessionTabIdByLocalKey } =
      await import('../../src/renderer/src/runtime/web-session-tabs-sync/state')
    const ids = Array.from({ length: n }, (_, i) => `mapped-${i.toString().padStart(5, '0')}`)
    const rig = await openAuthorityRuntime(await authorityProfile(ids, { visible: ids }))
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await rig.host.setSessionTabVisibility(ids[0]!, false)
    const issued = 'agent-chat-tab-v1-mapped-current'
    await rig.host.setSessionTabVisibility(ids[0]!, true, issued)
    await rig.runtime.publishStructuredAgentSessionTab({
      workspaceId: rig.workspace,
      sessionId: ids[0]!,
      agent: 'codex',
      tabId: issued,
      activate: false
    })
    const tabs = ids.map((id, index) => ({
      id: `renderer-${id}`,
      entityId: id,
      contentType: 'agent-session' as const,
      groupId: 'mapped-group',
      worktreeId: rig.workspace,
      label: id,
      customLabel: null,
      color: null,
      sortOrder: index,
      createdAt: 1
    }))
    let entityVisits = 0,
      orderVisits = 0
    for (const tab of tabs) {
      const id = tab.entityId
      Object.defineProperty(tab, 'entityId', {
        get: () => {
          entityVisits++
          return id
        }
      })
    }
    const order = tabs.map((tab) => tab.id)
    for (const [index, id] of order.entries()) {
      Object.defineProperty(order, index, {
        get: () => {
          orderVisits++
          return id
        }
      })
    }
    const state = makeState({
      folderWorkspaces: rig.profile.getFolderWorkspaces(),
      projectGroups: rig.profile.getProjectGroups(),
      unifiedTabsByWorktree: { [rig.workspace]: tabs },
      groupsByWorktree: {
        [rig.workspace]: [
          {
            id: 'mapped-group',
            worktreeId: rig.workspace,
            activeTabId: tabs[1]!.id,
            tabOrder: order,
            recentTabIds: [tabs[1]!.id]
          }
        ]
      }
    })
    try {
      const legacy = buildMobileSessionTabSnapshots(state, true)[0]!
      entityVisits = 0
      orderVisits = 0
      for (const [index, tab] of tabs.entries()) {
        mappings.setHostSessionTabIdMapping(
          { environmentId: 'local', worktreeId: rig.workspace, tabId: tab.id },
          index === 0 ? issued : `structured-agent-session-${tab.entityId}`
        )
      }
      const mappingReads = vi.spyOn(hostSessionTabIdByLocalKey, 'get')
      const frame = buildMobileSessionTabSnapshots(state, true)[0]!
      expect(frame).not.toBe(legacy)
      expect(frame.tabGroups?.[0]?.tabOrder[0]).toBe(issued)
      expect(mappingReads).toHaveBeenCalledTimes(n)
      expect(entityVisits).toBeGreaterThanOrEqual(n)
      expect(entityVisits).toBeLessThanOrEqual(5 * n)
      expect(orderVisits).toBeLessThanOrEqual(5 * n)
      mappingReads.mockClear()
      entityVisits = 0
      orderVisits = 0
      expect(buildMobileSessionTabSnapshots(state, true)[0]).toBe(frame)
      expect(mappingReads).toHaveBeenCalledTimes(n)
      expect(entityVisits).toBe(0)
      expect(orderVisits).toBe(0)
      rig.runtime.attachWindow(1)
      rig.runtime.markGraphReady(1)
      rig.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [frame] })
      const current = await rig.runtime.listMobileSessionTabs(rig.workspace)
      expect(current.tabs[0]?.id).toBe(issued)
      const { projectSessionTabs } =
        await import('../../src/shared/workspace-layout/old-client/old-client-session-tabs-projection')
      const { loaded } = loadChatTabLayout(
        'local',
        rig.profile.getWorkspaceSession(),
        rig.workspace
      )
      const savedWorkspace = loaded.layout.workspaces[rig.workspace]
      if (!savedWorkspace) {
        throw new Error('published chat must have saved layout')
      }
      const projected = projectSessionTabs(
        rig.workspace,
        savedWorkspace,
        { groups: {}, panes: {}, editorDrafts: {} },
        { tabLabels: {}, terminalRows: {}, browserTabs: {} },
        false
      )
      expect(projected.tabs.map((tab) => tab.id)).toContain(issued)
      expect(projected.tabGroups?.flatMap((group) => group.tabOrder)).toContain(issued)
      expect(projected.tabGroups?.flatMap((group) => group.tabOrder)).not.toContain(
        `agent-session:${ids[0]}`
      )
      const passive = {
        ...frame,
        snapshotVersion: frame.snapshotVersion + 1,
        activeTabId: `agent-session:${ids[0]}`,
        tabGroups: [
          {
            id: 'mapped-group',
            activeTabId: `agent-session:${ids[0]}`,
            recentTabIds: [`agent-session:${ids[0]}`, 'agent-chat-tab-v1-retired'],
            tabOrder: [
              `agent-session:${ids[0]}`,
              ...current.tabs.slice(1).map((tab) => tab.id),
              'agent-chat-tab-v1-retired'
            ]
          }
        ]
      }
      rig.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [passive] })
      const late = await rig.runtime.listMobileSessionTabs(rig.workspace)
      expect(late.tabs[0]?.id).toBe(issued)
      expect(late.tabGroups?.flatMap((group) => group.tabOrder)).not.toContain(
        `agent-session:${ids[0]}`
      )
      expect(late.tabGroups?.flatMap((group) => group.recentTabIds ?? [])).not.toContain(
        'agent-chat-tab-v1-retired'
      )
      expect(rig.acquire).not.toHaveBeenCalled()
    } finally {
      mappings.clearHostSessionTabIdMappings('local', rig.workspace)
    }
  }
)

it('keeps failed advisory legacy insertion and retention while the actual inner profile write waits', async () => {
  layoutOwner.main = true
  const { store: profile, authority } = await fixture()
  const { root, B, holdStartup, rejectVisibility, savedIds } =
    await import('../../src/main/runtime/structured-agent-session-tab-authority.test-support')
  const { installFakeAppEnvironment } = await import('../../config/scripts/vitest-host-ports-setup')
  installFakeAppEnvironment({ getPath: () => root })
  const base = await authorityProfile([B], { visible: [B] }, profile)
  const { workspace } = base
  const rig = await openAuthorityRuntime(base)
  expect(rig.store.getConversation(B)?.location.workspaceId).toBe(workspace)
  const releaseStartup = await holdStartup(rig)
  const { closeStructuredAgentSessionChild } =
    await import('../../src/main/runtime/agent-session/structured-agent-session-close')
  await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })
  await chatTabCommandsSettled()
  expect(savedIds(rig)).toEqual([])
  const gate = authority.pause()
  const holding = profile.runDurableMutation(() => {
    profile.updateSettings({ theme: 'dark' })
    return { value: undefined }
  })
  await gate.started.promise
  const applied = vi.spyOn(profile, 'applyLayoutCommand')
  const allow = rejectVisibility(rig)
  try {
    await rig.runtime.publishStructuredAgentSessionTab({
      workspaceId: workspace,
      sessionId: B,
      agent: 'claude',
      activate: true
    })
    await vi.waitFor(() => expect(applied).toHaveBeenCalled())
    expect(rig.runtime.live(B)).toBe(true)
    expect(savedIds(rig)).toEqual([])
    gate.finish.resolve()
    await holding
    const replies = await Promise.all(applied.mock.results.map((result) => result.value))
    expect(replies).toMatchObject([{ ok: true }])
    expect(rig.runtime.live(B)).toBe(true)
    await releaseStartup()
    await chatTabCommandsSettled()
    expect(savedIds(rig)).toEqual([B])
    await rig.runtime.publishStructuredAgentSessionTab({
      workspaceId: workspace,
      sessionId: B,
      agent: 'claude',
      activate: true
    })
    await Promise.all(applied.mock.results.map((result) => result.value))
    await chatTabCommandsSettled()
    expect(savedIds(rig)).toEqual([B])
    expect(rig.runtime.live(B)).toBe(true)
    expect(rig.store.isSessionTabVisible(B)).toBe(false)
    const snapshot = rig.runtime.mobileSessionTabsByWorktree.get(workspace)!
    rig.runtime.storeMobileSessionSnapshot(workspace, { ...snapshot, tabs: [] })
    expect(rig.runtime.live(B)).toBe(false)
    rig.runtime.storeMobileSessionSnapshot(workspace, snapshot)
    expect(rig.runtime.live(B)).toBe(true)
    rig.runtime.mobileSessionTabsByWorktree.delete(workspace)
    expect(rig.runtime.live(B)).toBe(false)
    expect(rig.acquire).not.toHaveBeenCalled()
  } finally {
    gate.finish.resolve()
    await holding
    await releaseStartup()
    allow()
    layoutOwner.main = false
  }
})

it.each([
  [10, 10],
  [100, 10],
  [10, 100]
] as const)(
  'counts complete supplied-member sweep and separate final retirement at S=%i N=%i',
  async (s, n) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const {
      createStructuredSweepProgress,
      closeStructuredSessionsForWorktree,
      retireStructuredSessionTabsForWorktree
    } = await import('../../src/main/runtime/structured-session-worktree-teardown')
    const ids = Array.from({ length: s }, (_, i) => `sweep-${i.toString().padStart(5, '0')}`)
    const background = Array.from({ length: n }, (_, i) => `other-${i.toString().padStart(5, '0')}`)
    const rig = await openAuthorityRuntime(
      await authorityProfile([...ids, ...background], { visible: [...ids, ...background] })
    )
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    const { root } =
      await import('../../src/main/runtime/structured-agent-session-tab-authority.test-support')
    const { folderWorkspaceKey } = await import('../../src/shared/workspace-scope')
    const other = folderWorkspaceKey(
      rig.profile.createFolderWorkspace({
        projectGroupId: rig.groupId,
        folderPath: `${root}/other`,
        name: 'Other workspace'
      }).id
    )
    const savedOther = withChatTabChanges(
      'local',
      rig.profile.getWorkspaceSession('local'),
      other,
      background.map((sessionId) => ({
        open: { sessionId, agent: 'codex', tabId: `other-${sessionId}` }
      }))
    )
    if (!savedOther) {
      throw new Error('unrelated saved rows must exist')
    }
    rig.profile.setWorkspaceSession(savedOther)
    const own = rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)!
    rig.runtime.storeMobileSessionSnapshot(rig.workspace, {
      ...own,
      tabGroups: own.tabs.map((row) => ({
        id: `g-${row.id}`,
        activeTabId: row.id,
        tabOrder: [row.id],
        recentTabIds: [row.id]
      }))
    })
    rig.runtime.storeMobileSessionSnapshot(other, {
      ...own,
      worktree: other,
      tabs: own.tabs.filter(
        (row) => row.type === 'agent-session' && background.includes(row.sessionId)
      ),
      tabGroups: []
    })
    await chatTabCommandsSettled()
    const unrelated = rig.runtime.mobileSessionTabsByWorktree.get(other)
    const counts = {
      saved: 0,
      savedBudget: 0,
      savedReads: 0,
      raw: 0,
      orders: 0,
      workspaces: 0,
      stores: 0,
      titlePassBudget: 0
    }
    const countedArrays = new WeakSet<object>(),
      countedRows = new WeakSet<object>()
    const instrument = <T>(rows: T[], key: 'raw' | 'orders') => {
      if (countedArrays.has(rows)) {
        return
      }
      countedArrays.add(rows)
      for (const [index, value] of rows.entries()) {
        Object.defineProperty(rows, index, {
          configurable: true,
          get: () => {
            counts[key]++
            return value
          }
        })
      }
    }
    const wrapSnapshot = (snapshot: RuntimeMobileSessionTabsSnapshot) => {
      instrument(snapshot.tabs, 'raw')
      for (const group of snapshot.tabGroups ?? []) {
        instrument(group.tabOrder, 'orders')
        if (group.recentTabIds) {
          instrument(group.recentTabIds, 'orders')
        }
      }
    }
    for (const snapshot of rig.runtime.mobileSessionTabsByWorktree.values()) {
      wrapSnapshot(snapshot)
    }
    const store = rig.runtime.storeMobileSessionSnapshot.bind(rig.runtime)
    vi.spyOn(rig.runtime, 'storeMobileSessionSnapshot').mockImplementation(
      (workspace, snapshot) => {
        counts.stores++
        wrapSnapshot(snapshot)
        const result = store(workspace, snapshot)
        wrapSnapshot(result)
        return result
      }
    )
    const saved = rig.profile.getWorkspaceSession.bind(rig.profile)
    vi.spyOn(rig.profile, 'getWorkspaceSession').mockImplementation((...args) => {
      const session = saved(...args)
      counts.savedReads++
      counts.savedBudget += Object.values(session.unifiedTabs ?? {}).reduce(
        (total, rows) => total + rows.length,
        0
      )
      for (const rows of Object.values(session.unifiedTabs ?? {})) {
        for (const row of rows) {
          if (countedRows.has(row)) {
            continue
          }
          countedRows.add(row)
          const entity = row.entityId
          Object.defineProperty(row, 'entityId', {
            configurable: true,
            get: () => {
              counts.saved++
              return entity
            }
          })
        }
      }
      return session
    })
    const entries = rig.runtime.mobileSessionTabsByWorktree[Symbol.iterator].bind(
      rig.runtime.mobileSessionTabsByWorktree
    )
    vi.spyOn(rig.runtime.mobileSessionTabsByWorktree, Symbol.iterator).mockImplementation(
      function* () {
        for (const entry of entries()) {
          counts.workspaces++
          yield entry
        }
        return undefined
      }
    )
    const retitle = rig.runtime.refreshStructuredConversationTabTitle.bind(rig.runtime)
    vi.spyOn(rig.runtime, 'refreshStructuredConversationTabTitle').mockImplementation(
      (workspace, id) => {
        counts.titlePassBudget +=
          rig.runtime.mobileSessionTabsByWorktree.get(workspace)?.tabs.length ?? 0
        return retitle(workspace, id)
      }
    )
    const close = vi.spyOn(rig.host, 'close')
    const members = ids.map((sessionId) => ({ sessionId, agent: 'codex' as const }))
    const measure = async (phase: () => Promise<void>) => {
      for (const key of [
        'saved',
        'savedBudget',
        'savedReads',
        'raw',
        'orders',
        'workspaces',
        'stores',
        'titlePassBudget'
      ] as const) {
        counts[key] = 0
      }
      await phase()
      await chatTabCommandsSettled()
      const result = { ...counts }
      // Each exact close re-reads saved layouts and rewrites/indexes its current snapshot.
      // The whole trigger is multiplicative in supplied members and current row population.
      expect(result.saved).toBeGreaterThan(0)
      // Client projection asks for each surviving title; each lookup scans saved rows.
      // Layout load additionally clones/reports its input. Charge those actual input populations.
      expect(result.savedReads).toBeLessThanOrEqual(s * (s + 2 * n + 8))
      expect(result.saved).toBeLessThanOrEqual(3 * result.savedBudget)
      console.info('whole-sweep-cost', { s, n, ...result })
      // Saved-write listeners retitle every surviving row, each mapping its current raw population.
      const retirementAndProjectionPasses = 24 * s * (s + 2 * n)
      const savedWriteRetitlePasses = 3 * result.titlePassBudget
      expect(result.raw + result.orders).toBeLessThanOrEqual(
        retirementAndProjectionPasses + savedWriteRetitlePasses
      )
      expect(result.stores).toBe(s)
      expect(result.workspaces).toBeLessThanOrEqual(4 * s)
      return result
    }
    const progress = createStructuredSweepProgress(members)
    await measure(() =>
      closeStructuredSessionsForWorktree(progress, 1_800_000_060_000, { runtime: rig.runtime })
    )
    expect(progress).toMatchObject({ closed: s, settled: s })
    expect(close).toHaveBeenCalledTimes(s)
    expect(
      rig.runtime.mobileSessionTabsByWorktree
        .get(rig.workspace)
        ?.tabs.map((row) => (row.type === 'agent-session' ? row.sessionId : null))
    ).toEqual(background)
    // Reopen real lifetimes so final retirement is a populated whole trigger, rather than an empty timing control.
    for (const sessionId of ids) {
      await rig.runtime.publishStructuredAgentSessionTab({
        workspaceId: rig.workspace,
        sessionId,
        agent: 'codex',
        activate: false,
        navigation: 'caller'
      })
    }
    await chatTabCommandsSettled()
    await measure(() => retireStructuredSessionTabsForWorktree(members, rig.runtime))
    await retireStructuredSessionTabsForWorktree(members, rig.runtime)
    await chatTabCommandsSettled()
    expect(rig.runtime.mobileSessionTabsByWorktree.get(other)).toBe(unrelated)
    expect(rig.acquire).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(s)
    expect(rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)?.tabs).toHaveLength(n)
  }
)

it.each([10, 100])(
  'copies, captures, retains and releases %i concrete pending opens through the inner profile queue',
  async (p) => {
    layoutOwner.main = true
    queueProbe.enabled = true
    queueProbe.copies = 0
    queueProbe.visits = 0
    const { store: profile, authority } = await fixture()
    const { root, B, rejectVisibility } =
      await import('../../src/main/runtime/structured-agent-session-tab-authority.test-support')
    const { installFakeAppEnvironment } =
      await import('../../config/scripts/vitest-host-ports-setup')
    installFakeAppEnvironment({ getPath: () => root })
    const ids = Array.from({ length: p }, (_, i) =>
      i === 0 ? B : `pending-${i.toString().padStart(5, '0')}`
    )
    const rig = await openAuthorityRuntime(
      await authorityProfile([], { records: ids, visible: [] }, profile)
    )
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    const queue = queueProbe.queues.at(-1)!
    const gate = authority.pause()
    const holding = profile.runDurableMutation(() => {
      profile.updateSettings({ theme: 'dark' })
      return { value: undefined }
    })
    await gate.started.promise
    const allow = vi.fn(rejectVisibility(rig))
    const { closeStructuredAgentSessionChild } =
      await import('../../src/main/runtime/agent-session/structured-agent-session-close')
    try {
      for (const sessionId of ids) {
        await rig.runtime.publishStructuredAgentSessionTab({
          workspaceId: rig.workspace,
          sessionId,
          agent: 'codex',
          activate: false
        })
      }
      queueProbe.copies = 0
      queueProbe.visits = 0
      const captured = rig.runtime.captureStructuredAgentSessionPresentation(B)
      expect(queueProbe.copies).toBe(p)
      expect(queueProbe.visits).toBe(p)
      expect(captured.saved).toHaveLength(1)
      const first = captured.saved[0]!
      expect(await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })).toMatchObject({
        stopped: true
      })
      allow()
      // Later legitimate open is not in the already admitted captured target set.
      await rig.runtime.publishStructuredAgentSessionTab({
        workspaceId: rig.workspace,
        sessionId: B,
        agent: 'codex',
        activate: false,
        navigation: 'caller'
      })
      const successor = rig.store.getSessionTabId(B)
      expect(successor).not.toBe(first.tabId)
      expect(captured.saved).toEqual([first])
      gate.finish.resolve()
      await holding
      await chatTabCommandsSettled()
      expect(queue.pendingOpens()).toHaveLength(0)
      expect(
        profile
          .getWorkspaceSession()
          .unifiedTabs?.[rig.workspace]?.find((row) => row.entityId === B)?.id
      ).toBe(successor)
      expect(authority.captures.length).toBeLessThanOrEqual(2 * p + 5)
      expect(rig.acquire).not.toHaveBeenCalled()
      // A refused/stale inner command released its descriptor, then a valid command progressed.
      expect(profile.getWorkspaceSession().unifiedTabs?.[rig.workspace]).toHaveLength(p)
    } finally {
      gate.finish.resolve()
      await holding
      if (!allow.mock.calls.length) {
        allow()
      }
    }
  }
)
