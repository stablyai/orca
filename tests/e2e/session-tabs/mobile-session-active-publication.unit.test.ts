import '../../../src/main/runtime/orca-runtime-tests/runtime-test-module-registration.spec'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { TEST_WORKTREE_ID as WT } from '../../../src/main/runtime/orca-runtime-tests/orca-runtime-test-fixtures.spec'
import { createRuntimeFixture } from './active-tab-publication.test-fixture'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../src/shared/runtime-session-contracts'
import { buildMobileSessionTabSnapshots } from '../../../src/renderer/src/runtime/sync-runtime-graph/mobile-session-snapshots'
import { makeState } from '../../../src/renderer/src/runtime/sync-runtime-graph/testing/sync-runtime-graph-test-harness'

import '../../../src/main/runtime/session-tabs/main-session-tab-rows'

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
})
