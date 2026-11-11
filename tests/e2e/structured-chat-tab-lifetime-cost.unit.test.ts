import { afterEach, expect, it, vi } from 'vitest'
import type * as ChatTabLayoutQueueModule from '../../src/main/runtime/agent-session/agent-session-tab-layout-queue'

import {
  authorityProfile,
  openAuthorityRuntime
} from '../../src/main/runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from '../../src/main/runtime/orca-runtime-tests/session-layout-apply.test-fixture'
import type { createChatTabLayoutQueue } from '../../src/main/runtime/agent-session/agent-session-tab-layout-queue'
import { fixture } from '../../src/main/persistence/loading-store/profile-writing/profile-state-delayed-authority-fixture'
import { loadChatTabLayout } from '../../src/main/runtime/agent-session/agent-session-tab-layout'

const queueProbe = vi.hoisted(() => {
  const queues: Pick<ReturnType<typeof createChatTabLayoutQueue>, 'pendingOpens'>[] = []
  return {
    enabled: false,
    copies: 0,
    visits: 0,
    queues
  }
})
vi.mock('../../src/main/runtime/agent-session/agent-session-tab-layout-queue', async (original) => {
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
  'publishes actual renderer mappings through the window graph in order at %i chats with linear trigger work',
  async (n) => {
    const { buildMobileSessionTabSnapshots } =
      await import('../../src/renderer/src/runtime/sync-runtime-graph/mobile-session-snapshots')
    const { makeState } =
      await import('../../src/renderer/src/runtime/sync-runtime-graph/testing/sync-runtime-graph-test-harness')
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
    await import('../../src/main/runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support')
  const { installFakeAppEnvironment } =
    await import('../../config/scripts/test-runtime/environment/vitest-host-ports-setup')
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

it.each([10, 100])(
  'copies, captures, retains and releases %i concrete pending opens through the inner profile queue',
  async (p) => {
    layoutOwner.main = true
    queueProbe.enabled = true
    queueProbe.copies = 0
    queueProbe.visits = 0
    const { store: profile, authority } = await fixture()
    const { root, B, rejectVisibility } =
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
