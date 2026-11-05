import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeDesktopSurface } from '../../src/main/runtime/runtime-desktop-surface'
import {
  authorityProfile,
  openAuthorityRuntime
} from '../../src/main/runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from '../../src/main/runtime/orca-runtime-tests/session-layout-apply.test-fixture'
import { fixture } from '../../src/main/persistence/loading-store/profile-state-delayed-authority-fixture'
import {
  loadChatTabLayout,
  withChatTabChanges
} from '../../src/main/runtime/agent-session/agent-session-tab-layout'

afterEach(() => {
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
  'publishes actual renderer mappings through the window graph in order at %i chats',
  async (n) => {
    const { buildMobileSessionTabSnapshots } =
      await import('../../src/renderer/src/runtime/sync-runtime-graph/mobile-session-snapshots')
    const { makeState } =
      await import('../../src/renderer/src/runtime/sync-runtime-graph-test-harness')
    const mappings =
      await import('../../src/renderer/src/runtime/web-session-tabs-sync/tracking-mappings')
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
    await chatTabCommandsSettled()
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
    const order = tabs.map((tab) => tab.id)
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
      buildMobileSessionTabSnapshots(state, true)
      for (const [index, tab] of tabs.entries()) {
        mappings.setHostSessionTabIdMapping(
          { environmentId: 'local', worktreeId: rig.workspace, tabId: tab.id },
          index === 0 ? issued : `structured-agent-session-${tab.entityId}`
        )
      }
      const frame = buildMobileSessionTabSnapshots(state, true)[0]!
      expect(frame.tabGroups?.[0]?.tabOrder[0]).toBe(issued)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hydration only asks whether this fixture's attached window is destroyed.
      vi.spyOn(getRuntimeDesktopSurface(), 'findWindowById').mockReturnValue({
        isDestroyed: () => false
      } as never)
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
      if (process.env.ORCA_NATIVE_PUBLICATION_BENCH === '1') {
        const samples: object[] = []
        for (let iteration = 0; iteration < 9; iteration++) {
          mappings.setHostSessionTabIdMapping(
            { environmentId: 'local', worktreeId: rig.workspace, tabId: tabs[0]!.id },
            iteration % 2 === 0 ? issued : `structured-agent-session-${ids[0]}`
          )
          for (const input of ['mapping-changed', 'unchanged']) {
            const started = performance.now()
            const cpu = process.cpuUsage()
            const measuredFrame = buildMobileSessionTabSnapshots(state, true)[0]!
            const rendererMs = performance.now() - started
            const rendererCpu = process.cpuUsage(cpu)
            rig.runtime.syncWindowGraph(1, {
              tabs: [],
              leaves: [],
              mobileSessionTabs: [measuredFrame]
            })
            const measured = await rig.runtime.listMobileSessionTabs(rig.workspace)
            const elapsedMs = performance.now() - started
            const totalCpu = process.cpuUsage(cpu)
            expect(measured.tabs[0]?.id).toBe(issued)
            if (iteration >= 2) {
              samples.push({
                input,
                rendererMs,
                hostMs: elapsedMs - rendererMs,
                elapsedMs,
                rendererCpuUs: rendererCpu.user + rendererCpu.system,
                hostCpuUs: totalCpu.user + totalCpu.system - rendererCpu.user - rendererCpu.system,
                totalCpuUs: totalCpu.user + totalCpu.system
              })
            }
          }
        }
        console.log('native-publication-benchmark', JSON.stringify({ n, warmup: 2, samples }))
      }
      expect(rig.acquire).not.toHaveBeenCalled()
    } finally {
      mappings.clearHostSessionTabIdMappings('local', rig.workspace)
    }
  }
)

it('rolls back rejected membership, retains legacy Retry presentation and accepts a later caller open', async () => {
  layoutOwner.main = true
  const { store: profile, authority } = await fixture()
  const { root, B, rejectVisibility, savedIds } =
    await import('../../src/main/runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support')
  const { installFakeAppEnvironment } =
    await import('../../config/scripts/test-runtime/environment/vitest-host-ports-setup')
  installFakeAppEnvironment({ getPath: () => root })
  const rig = await openAuthorityRuntime(
    await authorityProfile([], { records: [B], visible: [] }, profile)
  )
  await rig.runtime.restoreStructuredAgentSessionTabs()
  const allow = await rejectVisibility(rig)
  const gate = authority.pause()
  const publishing = rig.runtime.publishStructuredAgentSessionTab({
    workspaceId: rig.workspace,
    sessionId: B,
    agent: 'claude',
    activate: true
  })
  try {
    await gate.started.promise
    expect(savedIds(rig)).toEqual([])
    expect(rig.runtime.live(B)).toBe(false)
    gate.finish.resolve()
    await publishing
    expect(rig.store.isSessionTabVisible(B)).toBe(false)
    expect(savedIds(rig)).toEqual([])
    expect(
      profile.readWorkspaceSurfaces('local').filter((row) => row.workspaceId === rig.workspace)
    ).toEqual([])
    expect(rig.runtime.live(B)).toBe(true)
    await allow()
    await rig.runtime.publishStructuredAgentSessionTab({
      workspaceId: rig.workspace,
      sessionId: B,
      agent: 'claude',
      activate: true,
      navigation: 'caller'
    })
    await vi.waitFor(() => expect(savedIds(rig)).toEqual([B]))
    expect(rig.store.isSessionTabVisible(B)).toBe(true)
    expect(rig.runtime.live(B)).toBe(true)
    expect(rig.acquire).not.toHaveBeenCalled()
  } finally {
    gate.finish.resolve()
    await publishing
  }
})

describe.each(['close', 'retire'] as const)('%s supplied-member sweep', (phase) => {
  it.each([
    [10, 10],
    [100, 10],
    [10, 100]
  ] as const)(
    'keeps unaddressed chats and unrelated workspace state at S=%i N=%i',
    async (s, n) => {
      vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
      const {
        createStructuredSweepProgress,
        closeStructuredSessionsForWorktree,
        retireStructuredSessionTabsForWorktree
      } =
        await import('../../src/main/runtime/workspaces/removal/structured-session-worktree-teardown')
      const ids = Array.from({ length: s }, (_, i) => `sweep-${i.toString().padStart(5, '0')}`)
      const background = Array.from(
        { length: n },
        (_, i) => `other-${i.toString().padStart(5, '0')}`
      )
      const rig = await openAuthorityRuntime(
        await authorityProfile([...ids, ...background], { visible: [...ids, ...background] })
      )
      await rig.runtime.restoreStructuredAgentSessionTabs()
      await chatTabCommandsSettled()
      const { root } =
        await import('../../src/main/runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support')
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
      const unrelated = structuredClone(await rig.runtime.listMobileSessionTabs(other))
      const unrelatedSaved = structuredClone(rig.profile.getWorkspaceSession().unifiedTabs?.[other])
      expect(
        unrelated.tabs.flatMap((row) => (row.type === 'agent-session' ? [row.sessionId] : []))
      ).toEqual(background)
      const members = ids.map((sessionId) => ({ sessionId, agent: 'codex' as const }))
      const started = performance.now()
      const cpu = process.cpuUsage()
      if (phase === 'close') {
        const progress = createStructuredSweepProgress(members)
        await closeStructuredSessionsForWorktree(progress, 1_800_000_060_000, {
          runtime: rig.runtime
        })
        expect(progress).toMatchObject({ closed: s, settled: s })
      } else {
        await retireStructuredSessionTabsForWorktree(members, rig.runtime)
      }
      await chatTabCommandsSettled()
      if (process.env.ORCA_NATIVE_SWEEP_BENCH === '1') {
        console.info(
          'native-sweep-benchmark',
          JSON.stringify({
            phase,
            s,
            n,
            elapsedMs: performance.now() - started,
            cpu: process.cpuUsage(cpu)
          })
        )
      }
      const expected = structuredClone(await rig.runtime.listMobileSessionTabs(rig.workspace))
      expect(
        expected.tabs.flatMap((row) => (row.type === 'agent-session' ? [row.sessionId] : []))
      ).toEqual(background)
      expect(
        rig.profile
          .getWorkspaceSession()
          .unifiedTabs?.[rig.workspace]?.filter((row) => row.contentType === 'agent-session')
          .map((row) => row.entityId)
      ).toEqual(background)
      expect(
        rig.profile
          .readWorkspaceSurfaces('local')
          .filter((row) => row.workspaceId === rig.workspace)
          .flatMap((row) => (row.content?.kind === 'agent-session' ? [row.content.sessionId] : []))
      ).toEqual(background)
      const remainingOther = await rig.runtime.listMobileSessionTabs(other)
      expect(remainingOther.tabs).toEqual(unrelated.tabs)
      expect(remainingOther.tabGroups).toEqual(unrelated.tabGroups)
      expect(rig.profile.getWorkspaceSession().unifiedTabs?.[other]).toEqual(unrelatedSaved)
      if (phase === 'retire') {
        await retireStructuredSessionTabsForWorktree(members, rig.runtime)
        await chatTabCommandsSettled()
        expect((await rig.runtime.listMobileSessionTabs(rig.workspace)).tabs).toEqual(expected.tabs)
      }
      expect(rig.acquire).not.toHaveBeenCalled()
    }
  )
})

it.each([10, 100])(
  'settles %i native publications through the held profile owner and keeps a reopened successor',
  async (p) => {
    layoutOwner.main = true
    const { store: profile, authority } = await fixture()
    const { root, B } =
      await import('../../src/main/runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support')
    const { installFakeAppEnvironment } =
      await import('../../config/scripts/test-runtime/environment/vitest-host-ports-setup')
    installFakeAppEnvironment({ getPath: () => root })
    const ids = Array.from({ length: p }, (_, i) =>
      i === 0 ? B : `pending-${i.toString().padStart(5, '0')}`
    )
    const rig = await openAuthorityRuntime(
      await authorityProfile([], { records: ids, visible: [] }, profile)
    )
    await rig.runtime.restoreStructuredAgentSessionTabs()
    const gate = authority.pause()
    const publishing = Promise.all(
      ids.map((sessionId) =>
        rig.runtime.publishStructuredAgentSessionTab({
          workspaceId: rig.workspace,
          sessionId,
          agent: 'codex',
          activate: false
        })
      )
    )
    const { closeStructuredAgentSessionChild } =
      await import('../../src/main/runtime/agent-session/structured-agent-session-close')
    try {
      await gate.started.promise
      expect(profile.getWorkspaceSession().unifiedTabs?.[rig.workspace] ?? []).toEqual([])
      expect(rig.runtime.live(B)).toBe(false)
      gate.finish.resolve()
      await publishing
      await vi.waitFor(() =>
        expect(profile.getWorkspaceSession().unifiedTabs?.[rig.workspace]).toHaveLength(p)
      )
      const captured = rig.runtime.captureStructuredAgentSessionPresentation(B)
      expect(captured.saved).toHaveLength(1)
      const first = captured.saved[0]!
      expect(await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })).toMatchObject({
        stopped: true
      })
      await rig.runtime.publishStructuredAgentSessionTab({
        workspaceId: rig.workspace,
        sessionId: B,
        agent: 'codex',
        activate: false,
        navigation: 'caller'
      })
      const successor = rig.store.getSessionTabId(B)
      expect(successor).not.toBe(first.tabId)
      rig.runtime.removeCapturedStructuredSessionSavedTabs(B, captured.saved)
      await vi.waitFor(() =>
        expect(
          profile
            .getWorkspaceSession()
            .unifiedTabs?.[rig.workspace]?.find((row) => row.entityId === B)?.id
        ).toBe(successor)
      )
      expect(captured.saved).toEqual([first])
      expect(profile.getWorkspaceSession().unifiedTabs?.[rig.workspace]).toHaveLength(p)
      expect(rig.runtime.live(B)).toBe(true)
      expect(rig.acquire).not.toHaveBeenCalled()
    } finally {
      gate.finish.resolve()
      await publishing
    }
  }
)
