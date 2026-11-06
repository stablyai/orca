import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../src/main/runtime/orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID as WT,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../../src/main/runtime/orca-runtime-tests/orca-runtime-test-fixtures.spec'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../src/shared/runtime-session-contracts'
import { buildMobileSessionTabSnapshots } from '../../../src/renderer/src/runtime/sync-runtime-graph/mobile-session-snapshots'
import { makeState } from '../../../src/renderer/src/runtime/sync-runtime-graph-test-harness'
import { withMainSessionTabRows } from '../../../src/main/runtime/session-tabs/main-session-tab-rows'

const A = 'agent-session:chat-a'
const B = 'agent-session:chat-b'
const C = 'agent-session:chat-c'

afterEach(() => {
  vi.useRealTimers()
})

function createRuntime() {
  const session = makeWorkspaceSessionWithHeadlessTerminal({
    activeTabId: 'serve-tab',
    activeTabIdByWorktree: { [WT]: 'serve-tab' },
    tabsByWorktree: {
      [WT]: [
        {
          id: 'serve-tab',
          ptyId: 'serve-active',
          worktreeId: WT,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'serve-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-active' })
    }
  })
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [{ id: 'serve-active', cwd: TEST_WORKTREE_PATH, title: 'sh' }]
  })
  runtime.attachWindow(1)
  return runtime
}

async function publish(runtime: OrcaRuntimeService, id: string, activate = true) {
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: WT,
    sessionId: id.slice('agent-session:'.length),
    agent: id === A ? 'claude' : 'codex',
    activate
  })
}

function rendererFrame(selected: string, version: number): RuntimeMobileSessionTabsSnapshot {
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
  const snapshot = buildMobileSessionTabSnapshots(
    makeState({
      unifiedTabsByWorktree: { [WT]: chats },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'g',
            worktreeId: WT,
            activeTabId: chats.find((chat) => `agent-session:${chat.entityId}` === selected)!.id,
            tabOrder: chats.map((chat) => chat.id),
            recentTabIds: []
          }
        ]
      },
      activeGroupIdByWorktree: { [WT]: 'g' }
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
    expectSelection(await list(runtime), null)
    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WT, {
      force: true,
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], unchangedMobileSessionWorktrees: [WT] })
    expectSelection(await list(runtime), null)
    expect(
      runtime.mobileSessionTabsByWorktree.get(WT)?.tabGroups?.find((group) => group.id === 'g')
        ?.activeTabId
    ).toBe(B)
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

  it('resolves main-layout composition from group navigation even with no renderer chat row', () => {
    const frame = rendererFrame(B, 10)
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
      B
    )
  })
})
