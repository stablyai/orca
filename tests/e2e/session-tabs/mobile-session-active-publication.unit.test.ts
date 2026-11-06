import '../../../src/main/runtime/orca-runtime-tests/runtime-test-module-registration.spec'
import { withOpenedServeBrowserTab } from '../../../src/main/runtime/serve-browser-tab-layout'
import { applyPtyBinding } from '../../../src/main/persistence/loading-store/pty-binding-session-update'
import type { RuntimePtyController } from '../../../src/main/runtime/runtime-pty-controller-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  TEST_WORKTREE_ID as WT
} from '../../../src/main/runtime/orca-runtime-tests/orca-runtime-test-fixtures.spec'
import { createRuntimeFixture } from './active-tab-publication.test-fixture'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../src/shared/runtime-session-contracts'
import { buildMobileSessionTabSnapshots } from '../../../src/renderer/src/runtime/sync-runtime-graph/mobile-session-snapshots'
import { makeState } from '../../../src/renderer/src/runtime/sync-runtime-graph-test-harness'
import { getDefaultWorkspaceSession } from '../../../src/shared/constants'
import { committingSpawn } from '../../../src/main/runtime/orca-runtime-tests/bind-first-pane.test-fixture'
import { withMainSessionTabRows } from '../../../src/main/runtime/session-tabs/main-session-tab-rows'

const A = 'agent-session:chat-a'
const B = 'agent-session:chat-b'
const C = 'agent-session:chat-c'

afterEach(() => {
  vi.useRealTimers()
})

function createRuntime() {
  return createRuntimeFixture().runtime
}

async function publish(runtime: OrcaRuntimeService, id: string, activate = true) {
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: WT,
    sessionId: id.slice('agent-session:'.length),
    agent: id === A ? 'claude' : 'codex',
    activate
  })
}

function rendererFrame(
  selected: string,
  version: number,
  simulatorOnlyGroup = false
): RuntimeMobileSessionTabsSnapshot {
  const chats = [A, B, C].map((id, index) => ({
    id: `window-${index}`,
    entityId: id.slice('agent-session:'.length),
    contentType: 'agent-session' as const,
    groupId: 'g',
    worktreeId: WT,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: index,
    createdAt: 1
  }))
  const unified = [
    ...chats,
    {
      ...chats[0]!,
      id: 'sim-tab',
      entityId: 'simulator',
      contentType: 'simulator' as const,
      groupId: simulatorOnlyGroup ? 'sim-only' : 'g'
    }
  ]
  const snapshot = buildMobileSessionTabSnapshots(
    makeState({
      unifiedTabsByWorktree: { [WT]: unified },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'g',
            worktreeId: WT,
            activeTabId: unified.find((tab) =>
              tab.contentType === 'agent-session'
                ? `agent-session:${tab.entityId}` === (simulatorOnlyGroup ? A : selected)
                : !simulatorOnlyGroup && tab.id === selected
            )!.id,
            tabOrder: unified.filter((tab) => tab.groupId === 'g').map((tab) => tab.id),
            recentTabIds: []
          },
          ...(simulatorOnlyGroup
            ? [
                {
                  id: 'sim-only',
                  worktreeId: WT,
                  activeTabId: 'sim-tab',
                  tabOrder: ['sim-tab'],
                  recentTabIds: []
                }
              ]
            : [])
        ]
      },
      activeGroupIdByWorktree: { [WT]: simulatorOnlyGroup ? 'sim-only' : 'g' }
    }),
    false
  )[0]!
  return { ...snapshot, publicationEpoch: 'renderer:active-publication', snapshotVersion: version }
}

function accept(runtime: OrcaRuntimeService, frame: RuntimeMobileSessionTabsSnapshot) {
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [frame] })
}

const list = (runtime: OrcaRuntimeService) => runtime.listMobileSessionTabs(`id:${WT}`)
function expectSelection(
  snapshot: RuntimeMobileSessionTabsResult | RuntimeMobileSessionTabsSnapshot | undefined,
  id: string | null
) {
  expect(snapshot?.activeTabId).toBe(id)
  expect(snapshot?.activeTabType).toBe(id ? 'agent-session' : null)
  expect(snapshot?.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(id ? [id] : [])
}

describe('host active-tab publication', () => {
  it('publishes the actual renderer-selected chat to list and live readers while retaining both chats', async () => {
    vi.useFakeTimers()
    const runtime = createRuntime()
    await publish(runtime, A)
    await publish(runtime, B, false)
    const seen: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => seen.push(snapshot))
    const frame = rendererFrame(B, 10)
    expect(frame.tabs).toEqual([])
    expect(frame.tabGroups?.[0]?.activeTabId).toBe(B)
    accept(runtime, frame)
    await vi.runAllTimersAsync()
    expectSelection(await list(runtime), B)
    expectSelection(seen.at(-1), B)
    expect((await list(runtime)).tabs.map((tab) => tab.id)).toEqual(expect.arrayContaining([A, B]))
  })

  it('selects the current terminal leaf over a preserved active chat', async () => {
    const runtime = createRuntime()
    await publish(runtime, A)
    const frame: RuntimeMobileSessionTabsSnapshot = {
      ...rendererFrame(A, 10),
      activeTabId: 'term::right',
      activeTabType: 'terminal',
      tabGroups: [{ id: 'g', activeTabId: 'term', tabOrder: [A, 'term'] }],
      tabs: ['left', 'right'].map((leafId) => ({
        type: 'terminal',
        id: `term::${leafId}`,
        parentTabId: 'term',
        leafId,
        title: 'Split terminal',
        isActive: leafId === 'right'
      }))
    }
    accept(runtime, frame)
    const result = await list(runtime)
    expect(result.activeTabId).toBe('term::right')
    expect(result.activeTabType).toBe('terminal')
    expect(result.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(['term::right'])
  })

  it('keeps pending navigation through hydration and unchanged frames, then resolves passive restoration without another frame', async () => {
    const runtime = createRuntime()
    await publish(runtime, A)
    accept(runtime, rendererFrame(B, 10))
    const pending = await list(runtime)
    expectSelection(pending, null)
    expect(pending.tabGroups?.find((group) => group.id === 'g')?.activeTabId).toBeNull()
    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WT, {
      force: true,
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [],
      unchangedMobileSessionWorktrees: [WT]
    })
    expectSelection(await list(runtime), null)
    expect(
      runtime.mobileSessionTabsByWorktree.get(WT)?.tabGroups?.find((group) => group.id === 'g')
        ?.activeTabId
    ).toBe(B)
    await publish(runtime, B, false)
    expectSelection(await list(runtime), B)
  })

  it('does not substitute a preserved row for an unavailable explicit legacy selection', async () => {
    const runtime = createRuntime()
    await publish(runtime, A)
    accept(runtime, {
      ...rendererFrame(B, 10),
      tabGroups: undefined,
      activeGroupId: null,
      activeTabId: B,
      activeTabType: 'agent-session'
    })
    expectSelection(await list(runtime), null)
  })

  it('retains the current split layout across runtime-owned hydration before persistence catches up', async () => {
    vi.useFakeTimers()
    const { runtime, getSession, setSession } = createRuntimeFixture()
    await publish(runtime, A)
    setSession({
      ...getSession(),
      tabGroups: {
        [WT]: [
          { id: 'g', worktreeId: WT, activeTabId: B, tabOrder: [A, B], recentTabIds: [] },
          {
            id: 'g2',
            worktreeId: WT,
            activeTabId: 'serve-tab',
            tabOrder: ['serve-tab'],
            recentTabIds: []
          }
        ]
      },
      activeGroupIdByWorktree: { [WT]: 'g' },
      tabGroupLayouts: {
        [WT]: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', groupId: 'g' },
          second: { type: 'leaf', groupId: 'g2' }
        }
      }
    })
    const frame: RuntimeMobileSessionTabsSnapshot = {
      ...rendererFrame(B, 10),
      tabGroups: [
        { id: 'g', activeTabId: B, tabOrder: [A, B] },
        { id: 'g2', activeTabId: 'serve-tab', tabOrder: ['serve-tab'] }
      ],
      tabGroupLayout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'g' },
        second: { type: 'leaf', groupId: 'g2' }
      }
    }
    accept(runtime, frame)
    await vi.runAllTimersAsync()
    expect(runtime.mobileSessionTabsByWorktree.get(WT)?.tabGroupLayout).toEqual(
      frame.tabGroupLayout
    )
    const seen: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => seen.push(snapshot))
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [],
      unchangedMobileSessionWorktrees: [WT]
    })
    await vi.runAllTimersAsync()
    expect(runtime.mobileSessionTabsByWorktree.get(WT)?.tabGroupLayout).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'g' },
      second: { type: 'leaf', groupId: 'g2' }
    })
    expect(seen).toEqual([])
  })

  it('restores a single saved group with a pending chat without selecting the materialized terminal', async () => {
    const { runtime, getSession, setSession } = createRuntimeFixture()
    setSession({
      ...getSession(),
      tabGroups: {
        [WT]: [
          { id: 'g', worktreeId: WT, activeTabId: B, tabOrder: ['serve-tab', B], recentTabIds: [] }
        ]
      },
      activeGroupIdByWorktree: { [WT]: 'g' },
      tabGroupLayouts: { [WT]: { type: 'leaf', groupId: 'g' } }
    })
    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WT, {
      force: true,
      allowAttachedWindow: true
    })
    expectSelection(await list(runtime), null)
    expect(runtime.mobileSessionTabsByWorktree.get(WT)?.activeGroupId).toBe('g')
    await publish(runtime, B, false)
    expectSelection(await list(runtime), B)
  })

  it('does not let late restoration replace a newer explicit selection', async () => {
    const runtime = createRuntime()
    await publish(runtime, A)
    accept(runtime, rendererFrame(B, 10))
    await publish(runtime, C)
    await publish(runtime, B, false)
    expectSelection(await list(runtime), C)
  })

  it('keeps main-created inventory while current renderer navigation wins, and fences older renderer revisions', async () => {
    const runtime = createRuntime()
    await publish(runtime, A)
    accept(runtime, rendererFrame(A, 10))
    const beforeCreate = rendererFrame(A, 11)
    await publish(runtime, C)
    accept(runtime, beforeCreate)
    expectSelection(await list(runtime), A)
    expect((await list(runtime)).tabs.map((tab) => tab.id)).toContain(C)
    accept(runtime, rendererFrame(C, 12))
    accept(runtime, beforeCreate)
    expectSelection(await list(runtime), C)
  })

  it.each([
    [B, false],
    ['sim-tab', false],
    ['sim-tab', true]
  ] as const)('resolves main-layout group selection %s (omitted group=%s)', (selected, omitted) => {
    const frame = rendererFrame(selected, 10, omitted)
    const chat = {
      type: 'agent-session' as const,
      id: A,
      title: 'Chat A',
      sessionId: 'chat-a',
      agent: 'claude' as const,
      isActive: true
    }
    const projected = {
      ...frame,
      activeTabId: A,
      activeTabType: 'agent-session' as const,
      tabs: [chat],
      tabGroups: [{ id: 'g', activeTabId: A, tabOrder: [A, B] }]
    }
    expectSelection(
      withMainSessionTabRows(frame, projected, () => false),
      null
    )
    expectSelection(
      withMainSessionTabRows(
        frame,
        { ...projected, tabs: [chat, { ...chat, id: B, sessionId: 'chat-b', isActive: false }] },
        () => false
      ),
      selected === B ? B : null
    )
  })
  it.each([false, true])(
    'publishes no active recipient for an unpublished simulator (own group=%s)',
    async (ownGroup) => {
      const runtime = createRuntime()
      await publish(runtime, A)
      const frame = rendererFrame('sim-tab', 10, ownGroup)
      if (ownGroup) {
        expect(frame.tabGroups?.some((group) => group.id === frame.activeGroupId)).toBe(false)
      } else {
        expect(frame.tabGroups?.[0]?.activeTabId).toBeNull()
      }
      accept(runtime, frame)
      expectSelection(await list(runtime), null)
      expect(
        (await list(runtime)).tabGroups?.find((group) => group.id === frame.activeGroupId)
          ?.activeTabId ?? null
      ).toBeNull()
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [],
        unchangedMobileSessionWorktrees: [WT]
      })
      await publish(runtime, B, false)
      expectSelection(await list(runtime), null)
    }
  )

  it.each([false, true])(
    'retains legacy pending navigation with existing snapshot=%s until passive materialization',
    async (existing) => {
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
      const runtime = new OrcaRuntimeService(runtimeStore)
      runtime.attachWindow(1)
      if (existing) {
        accept(runtime, {
          ...rendererFrame(A, 9),
          tabGroups: undefined,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null
        })
      }
      accept(runtime, {
        ...rendererFrame(B, 10),
        tabGroups: undefined,
        activeGroupId: null,
        activeTabId: B,
        activeTabType: 'agent-session'
      })
      expectSelection(await list(runtime), null)
      runtime.projectStructuredAgentSessionTab({
        workspaceId: WT,
        sessionId: 'chat-b',
        agent: 'codex',
        activate: false
      })
      expectSelection(await list(runtime), B)
    }
  )

  it('restores saved chat-only navigation through normal list preparation before passive rows arrive', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabGroups: { [WT]: [{ id: 'saved', worktreeId: WT, activeTabId: B, tabOrder: [A, B] }] },
      activeGroupIdByWorktree: { [WT]: 'saved' },
      tabGroupLayouts: { [WT]: { type: 'leaf', groupId: 'saved' } }
    })
    const runtime = new OrcaRuntimeService(runtimeStore)
    expectSelection(await list(runtime), null)
    runtime.projectStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'chat-a',
      agent: 'claude',
      activate: false
    })
    runtime.projectStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'chat-b',
      agent: 'codex',
      activate: false
    })
    const result = await list(runtime)
    expectSelection(result, B)
    expect(result.activeGroupId).toBe('saved')
  })

  it('preserves pending chat navigation through an unrelated whole-terminal close', async () => {
    const { runtime } = createRuntimeFixture(false)
    const ids = ['serve-active']
    runtime.setPtyController({
      spawn: committingSpawn(runtime, async () => {
        ids.push('serve-created')
        return { id: 'serve-created' }
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => ids.map((id) => ({ id, cwd: TEST_WORKTREE_PATH, title: 'sh' }))
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const created = await runtime.createMobileSessionTerminal(`id:${WT}`, { activate: false })
    const snapshot = runtime.mobileSessionTabsByWorktree.get(WT)!
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          ...snapshot,
          publicationEpoch: 'headless:pending-close',
          snapshotVersion: 10,
          activeGroupId: 'g',
          activeTabId: null,
          activeTabType: null,
          tabGroups: [
            { id: 'g', activeTabId: B, tabOrder: ['serve-tab', created.tab.parentTabId, B] }
          ],
          tabs: snapshot.tabs.map((tab) => ({ ...tab, isActive: false }))
        }
      ]
    })
    await runtime.closeMobileSessionTab(`id:${WT}`, created.tab.parentTabId)
    expectSelection(await list(runtime), null)
    runtime.projectStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'chat-b',
      agent: 'codex',
      activate: false
    })
    expectSelection(await list(runtime), B)
  })

  it.each([false, true])(
    'persists headless host activation and creation without replacing saved desktop groups (ready=%s)',
    async (ready) => {
      const { runtime, runtimeStore, getSession, setSession } = createRuntimeFixture(false)
      const ids = ready ? ['serve-active'] : []
      runtimeStore.persistPtyBinding = vi.fn(async (input) => {
        const args = typeof input === 'function' ? input() : input
        if (!args) {
          return false
        }
        applyPtyBinding(args, getSession(), args.worktreeId, `${args.tabId}:${args.leafId}`)
        return true
      })
      const controller: RuntimePtyController = {
        spawn: committingSpawn(runtime, async () => {
          const id = `serve-created-${ids.length}`
          ids.push(id)
          return { id }
        }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => ids.map((id) => ({ id, cwd: TEST_WORKTREE_PATH, title: 'sh' }))
      }
      runtime.setPtyController(controller)
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      if (ready) {
        runtime.registerPty('serve-active', WT, null, {
          tabId: 'serve-tab',
          leafId: HEADLESS_LEAF_ID
        })
      }
      const created = await runtime.createMobileSessionTerminal(`id:${WT}`, { activate: false })
      const snapshot = runtime.mobileSessionTabsByWorktree.get(WT)!
      runtime.syncWindowGraph(0, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            ...snapshot,
            publicationEpoch: 'headless:split-activation',
            snapshotVersion: 10,
            activeGroupId: 'right',
            activeTabId: created.tab.id,
            activeTabType: 'terminal',
            tabGroups: [
              { id: 'left', activeTabId: 'serve-tab', tabOrder: ['serve-tab'] },
              {
                id: 'right',
                activeTabId: created.tab.parentTabId,
                tabOrder: [created.tab.parentTabId]
              }
            ],
            tabs: snapshot.tabs.map((tab) => ({ ...tab, isActive: tab.id === created.tab.id }))
          }
        ]
      })
      const groups = runtime.mobileSessionTabsByWorktree.get(WT)!.tabGroups!
      setSession({
        ...getSession()!,
        tabGroups: {
          [WT]: groups.map((group) => ({
            ...group,
            worktreeId: WT,
            tabOrder:
              group.id === 'right'
                ? [...group.tabOrder, 'chat-window', 'sim-window']
                : group.tabOrder
          }))
        },
        unifiedTabs: {
          [WT]: [
            {
              id: 'chat-window',
              entityId: 'chat-a',
              contentType: 'agent-session',
              groupId: 'right',
              worktreeId: WT,
              label: 'Chat',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            },
            {
              id: 'sim-window',
              entityId: 'simulator',
              contentType: 'simulator',
              groupId: 'right',
              worktreeId: WT,
              label: 'Simulator',
              customLabel: null,
              color: null,
              sortOrder: 1,
              createdAt: 1
            }
          ]
        },
        activeGroupIdByWorktree: { [WT]: 'right' }
      })
      expect((await list(runtime)).activeGroupId).toBe('right')
      expect((await list(runtime)).activeTabId).toBe(created.tab.id)
      const target = (await list(runtime)).tabs.find(
        (tab) => tab.id === `serve-tab::${HEADLESS_LEAF_ID}`
      )
      expect(target?.type).toBe('terminal')
      expect(target?.type === 'terminal' && target.status === 'ready').toBe(ready)
      const savedRight = getSession().tabGroups![WT]!.find((group) => group.id === 'right')
      const activated = await runtime.activateMobileSessionTab(
        `id:${WT}`,
        'serve-tab',
        HEADLESS_LEAF_ID,
        { navigation: 'host' }
      )
      expect(activated.activeGroupId).toBe('left')
      expect(activated.activeTabId).toBe(`serve-tab::${HEADLESS_LEAF_ID}`)
      expect(getSession().tabGroups![WT]!.find((group) => group.id === 'right')).toEqual(savedRight)
      expect(getSession().unifiedTabs![WT]!.map((tab) => tab.id)).toEqual([
        'chat-window',
        'sim-window'
      ])
      const restored = new OrcaRuntimeService(runtimeStore)
      restored.setPtyController(controller)
      const restoredSelection = await list(restored)
      expect(restoredSelection.activeGroupId).toBe('left')
      expect(restoredSelection.activeTabId).toBe(`serve-tab::${HEADLESS_LEAF_ID}`)
      await runtime.activateMobileSessionTab(
        `id:${WT}`,
        created.tab.parentTabId,
        created.tab.leafId,
        { navigation: 'host' }
      )
      const another = await runtime.createMobileSessionTerminal(`id:${WT}`, {
        activate: true,
        targetGroupId: 'right'
      })
      const result = await list(runtime)
      expect(result.activeTabId).toBe(another.tab.id)
      expect(result.activeGroupId).toBe(
        result.tabGroups?.find((group) => group.tabOrder.includes(another.tab.parentTabId))?.id
      )
      expect(result.activeGroupId).toBe('right')
      const reloaded = new OrcaRuntimeService(runtimeStore)
      reloaded.setPtyController(controller)
      const afterCreateReload = await list(reloaded)
      expect(afterCreateReload.activeGroupId).toBe('right')
      expect(afterCreateReload.activeTabId).toBe(another.tab.id)
      expect(getSession().tabGroups![WT]!.find((group) => group.id === 'right')?.tabOrder).toEqual([
        created.tab.parentTabId,
        'chat-window',
        'sim-window',
        another.tab.parentTabId
      ])
    }
  )

  it.each([B, C, null])(
    'retires a native lifetime without replacing unrelated navigation %s',
    async (selected) => {
      vi.useFakeTimers()
      const { runtime } = createRuntimeFixture(false)
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      await publish(runtime, A)
      await publish(runtime, B)
      const snapshot = runtime.mobileSessionTabsByWorktree.get(WT)!
      runtime.syncWindowGraph(0, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            ...snapshot,
            publicationEpoch: 'headless:retirement',
            snapshotVersion: 20,
            activeGroupId: 'closing',
            activeTabId: selected === B ? B : null,
            activeTabType: selected === B ? 'agent-session' : null,
            tabGroups: [
              { id: 'closing', activeTabId: selected, tabOrder: [B, C] },
              { id: 'replacement', activeTabId: A, tabOrder: [A] }
            ],
            tabs: snapshot.tabs
              .filter((tab) => tab.type === 'agent-session')
              .map((tab) => ({ ...tab, isActive: selected === B && tab.id === B }))
          }
        ]
      })
      const seen: RuntimeMobileSessionTabsResult[] = []
      runtime.onMobileSessionTabsChanged((snapshot) => seen.push(snapshot))
      expect(runtime.retireStructuredAgentSessionTabFromSnapshot('chat-b', B, WT)).toBe(true)
      await vi.runAllTimersAsync()
      expectSelection(await list(runtime), selected === B ? A : null)
      expectSelection(seen.at(-1), selected === B ? A : null)
      if (selected === B) {
        expect((await list(runtime)).activeGroupId).toBe('replacement')
      }
      await publish(runtime, C, false)
      expectSelection(await list(runtime), selected === B ? A : selected === C ? C : null)
    }
  )

  it('publishes replacement navigation after a public offscreen selected-browser close', async () => {
    vi.useFakeTimers()
    const { runtime, setSession } = createRuntimeFixture(false)
    let saved = getDefaultWorkspaceSession()
    for (const pageId of ['page-a', 'page-b']) {
      saved = withOpenedServeBrowserTab('local', saved, {
        worktreeId: WT,
        pageId,
        url: 'https://example.com/',
        title: pageId
      })!
    }
    setSession({
      ...saved,
      tabGroups: {
        [WT]: [
          { id: 'replacement', worktreeId: WT, activeTabId: 'page-a', tabOrder: ['page-a'] },
          { id: 'closing', worktreeId: WT, activeTabId: 'page-b', tabOrder: ['page-b'] }
        ]
      },
      activeGroupIdByWorktree: { [WT]: 'closing' }
    })
    runtime.setOffscreenBrowserBackend({
      createTab: vi.fn(async () => ({ browserPageId: 'unused' })),
      closeTab: vi.fn(async () => {}),
      ownsTab: () => true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Saved unstarted pages require only this bridge inventory.
    runtime.setAgentBrowserBridge({ tabList: () => ({ tabs: [] }) } as never)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    expect((await list(runtime)).activeTabId).toBe('page-b')
    const seen: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => seen.push(snapshot))
    await runtime.closeMobileSessionTab(`id:${WT}`, 'page-b')
    await vi.runAllTimersAsync()
    const result = await list(runtime)
    expect(result.activeTabId).toBe('page-a')
    expect(result.activeTabType).toBe('browser')
    expect(result.activeGroupId).toBe('replacement')
    expect(result.tabs.map((tab) => [tab.id, tab.isActive])).toEqual([['page-a', true]])
    expect(seen.at(-1)?.activeTabId).toBe('page-a')
  })

  it('restores the actual headless editor-close replacement after cold hydration', async () => {
    const { runtime, runtimeStore, getSession, setSession } = createRuntimeFixture(false)
    setSession({
      ...getSession(),
      openFilesByWorktree: {
        [WT]: [
          {
            filePath: '/qa/notes.ts',
            relativePath: 'notes.ts',
            language: 'typescript',
            worktreeId: WT
          }
        ]
      },
      unifiedTabs: {
        [WT]: [
          {
            id: 'editor-window',
            entityId: '/qa/notes.ts',
            contentType: 'editor',
            groupId: 'editor',
            worktreeId: WT,
            label: 'notes.ts',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [WT]: [
          { id: 'terminal', worktreeId: WT, activeTabId: 'serve-tab', tabOrder: ['serve-tab'] },
          {
            id: 'editor',
            worktreeId: WT,
            activeTabId: 'editor-window',
            tabOrder: ['editor-window']
          }
        ]
      },
      activeGroupIdByWorktree: { [WT]: 'editor' },
      activeTabIdByWorktree: { [WT]: 'editor-window' },
      activeTabTypeByWorktree: { [WT]: 'editor' },
      activeFileIdByWorktree: { [WT]: '/qa/notes.ts' }
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    expect((await list(runtime)).activeTabId).toBe('editor-window')
    await runtime.closeMobileSessionTab(`id:${WT}`, 'editor-window')
    expect((await list(runtime)).activeTabId).toBe(`serve-tab::${HEADLESS_LEAF_ID}`)
    const restored = new OrcaRuntimeService(runtimeStore)
    expect((await list(restored)).activeTabId).toBe(`serve-tab::${HEADLESS_LEAF_ID}`)
    expect((await list(restored)).activeGroupId).toBe('terminal')
  })

  it('reorders headless membership while retaining an explicit null selection', async () => {
    const { runtime } = createRuntimeFixture(false)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    await publish(runtime, A, false)
    await publish(runtime, B, false)
    const snapshot = runtime.mobileSessionTabsByWorktree.get(WT)!
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          ...snapshot,
          publicationEpoch: 'headless:reorder',
          snapshotVersion: 30,
          activeGroupId: 'g',
          activeTabId: null,
          activeTabType: null,
          tabGroups: [{ id: 'g', activeTabId: null, tabOrder: [A, B, 'serve-tab'] }],
          tabs: snapshot.tabs.map((tab) => ({ ...tab, isActive: false }))
        }
      ]
    })
    await runtime.moveMobileSessionTab(`id:${WT}`, {
      kind: 'reorder',
      tabId: A,
      targetGroupId: 'g',
      tabOrder: [B, A, 'serve-tab']
    })
    const result = await list(runtime)
    expectSelection(result, null)
    expect(result.tabGroups?.[0]?.tabOrder).toEqual([B, A, 'serve-tab'])
  })
})
