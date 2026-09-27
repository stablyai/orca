import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '../../src/renderer/src/lib/agent-status'
import { projectPresentationView } from '../../src/renderer/src/lib/cross-machine-recovery-presentation-projection'
import { reconcileHydratedWorkspaceTabModels } from '../../src/renderer/src/app-shell/reconcile-hydrated-workspace-tab-models'
import { fixture as durableStoreFixture } from '../../src/main/persistence/loading-store/profile-state-delayed-authority-fixture'
import { buildRecoveryDescriptor } from '../../src/main/runtime/cross-machine-recovery/recovery-export'
import { planRecoveryImport } from '../../src/main/runtime/cross-machine-recovery/recovery-import-plan'
import { withPreferredClientView } from '../../src/main/runtime/cross-machine-recovery/recovery-import.test-fixture'
import type { SleepingAgentSessionRecord } from '../../src/shared/agent-session-resume'
import type { OrcaRecoveryDescriptorV1 } from '../../src/shared/cross-machine-recovery-descriptor'
import { OrcaRecoveryDescriptorV1Schema } from '../../src/shared/rpc-contract/cross-machine-recovery-params'
import { parsePaneKey } from '../../src/shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import type { Worktree } from '../../src/shared/worktree/types'
import { handleCrossMachineRecoveryApplyRequest } from '../../src/renderer/src/store/slices/cross-machine-recovery-apply'
import { createStoreSessionMockApi } from '../../src/renderer/src/store/slices/store-session-test-harness'
import {
  createTestStore,
  makeWorktree,
  TEST_REPO
} from '../../src/renderer/src/store/slices/store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../src/renderer/src/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const SOURCE_PATH = '/fixture/groupless'
const SOURCE_WT = `repo-local::${SOURCE_PATH}`
const WT = 'repo1::/repo1/wt'

const sourceWorktree: Worktree = {
  id: SOURCE_WT,
  instanceId: 'instance-groupless',
  repoId: 'repo-local',
  path: SOURCE_PATH,
  head: 'abc',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: false,
  displayName: 'groupless',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

// Why: host-admitted spawns persist runtime rows and leaf layouts with no unified tab or group.
async function exportGrouplessHost(): Promise<OrcaRecoveryDescriptorV1> {
  const { store, readState } = await durableStoreFixture()
  const panes = [0, 1, 2].map((index) => ({
    tabId: randomUUID(),
    leafId: randomUUID(),
    ptyId: `groupless-pty-${index}`
  }))
  for (const pane of panes) {
    expect(
      await store.persistPtyBinding({
        worktreeId: SOURCE_WT,
        ...pane,
        hostAdmittedMembership: true
      })
    ).toBe(true)
  }
  const records: SleepingAgentSessionRecord[] = panes.map((pane, index) => ({
    paneKey: `${pane.tabId}:${pane.leafId}`,
    tabId: pane.tabId,
    worktreeId: SOURCE_WT,
    agent: 'claude',
    providerSession: { key: 'session_id', id: randomUUID() },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1 + index,
    origin: 'quit'
  }))
  store.patchWorkspaceSession({
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      records.map((record) => [record.paneKey, record])
    )
  })
  await store.flushPendingOrThrowAsync()
  const persisted: WorkspaceSessionState = readState().workspaceSession
  expect(persisted.tabsByWorktree[SOURCE_WT]?.map((tab) => tab.id)).toEqual(
    panes.map((pane) => pane.tabId)
  )
  expect(persisted.unifiedTabs?.[SOURCE_WT]).toBeUndefined()
  expect(persisted.tabGroups?.[SOURCE_WT]).toBeUndefined()
  expect(Object.keys(persisted.sleepingAgentSessionsByPaneKey ?? {}).toSorted()).toEqual(
    records.map((record) => record.paneKey).toSorted()
  )
  const repo = store.getRepos().find((candidate) => candidate.id === 'repo-local')!
  return buildRecoveryDescriptor({
    now: 5,
    source: {
      runtimeId: 'rt-src',
      appVersion: '1.0.0',
      machineName: 'laptop',
      platform: 'darwin',
      executionHostId: 'local'
    },
    repo,
    worktree: sourceWorktree,
    session: store.getWorkspaceSession('local'),
    liveStatuses: [],
    structuredRecords: [],
    presentation: { views: [], preferredClientKey: null }
  })
}

function withGrouplessClientView(descriptor: OrcaRecoveryDescriptorV1): OrcaRecoveryDescriptorV1 {
  const view = projectPresentationView(
    {
      activeRepoId: null,
      activeWorktreeId: SOURCE_WT,
      activeTabId: null,
      tabsByWorktree: {
        [SOURCE_WT]: descriptor.layout.terminalTabs.map((tab) => ({
          ...tab,
          ptyId: null,
          worktreeId: SOURCE_WT
        }))
      },
      terminalLayoutsByTabId: descriptor.layout.terminalLayouts
    },
    SOURCE_WT,
    SOURCE_PATH
  )
  expect(view.tabs).toEqual([])
  expect(view.groups).toEqual([])
  return withPreferredClientView(descriptor, view)
}

function destinationStore() {
  const store = createTestStore()
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/repo1/wt' })] }
  })
  return store
}

function expectEveryRecordReachable(
  state: ReturnType<ReturnType<typeof createTestStore>['getState']>,
  records: readonly SleepingAgentSessionRecord[]
): void {
  for (const record of records) {
    const pane = parsePaneKey(record.paneKey)!
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toEqual(record)
    expect(state.tabsByWorktree[WT]?.map((tab) => tab.id)).toContain(pane.tabId)
    expect(state.terminalLayoutsByTabId[pane.tabId]?.root).toEqual({
      type: 'leaf',
      leafId: pane.leafId
    })
    const tab = state.unifiedTabsByWorktree[WT]?.find(
      (candidate) => candidate.contentType === 'terminal' && candidate.entityId === pane.tabId
    )
    const group = state.groupsByWorktree[WT]?.find((candidate) => candidate.id === tab?.groupId)
    expect(group?.tabOrder).toContain(tab?.id)
  }
}

describe('cross-machine recovery import of a host whose terminals have no tab groups', () => {
  it.each([
    ['host-only', (d: OrcaRecoveryDescriptorV1) => d],
    ['groupless client view', withGrouplessClientView]
  ])(
    'keeps every dormant binding on a visible tab through apply and reload (%s)',
    async (_name, present) => {
      const exported = await exportGrouplessHost()
      expect(exported.layout.tabs).toEqual([])
      expect(exported.layout.groups).toEqual([])
      expect(exported.bindings).toHaveLength(3)
      const parsed = OrcaRecoveryDescriptorV1Schema.safeParse(present(exported))
      expect(parsed.success).toBe(true)
      const plan = planRecoveryImport(parsed.data!, undefined, {
        worktreeId: WT,
        checkoutPath: '/repo1/wt',
        sourceWorkspacePath: SOURCE_PATH,
        now: 1_000,
        mintId: () => randomUUID(),
        importKey: 'key',
        pathMap: [],
        sourceProviderSessionIds: new Map()
      })
      const records = plan.bindings.flatMap((planned) => (planned.record ? [planned.record] : []))
      expect(plan.bindings.map((planned) => planned.result.status)).toEqual([
        'dormant',
        'dormant',
        'dormant'
      ])
      const store = destinationStore()
      const set = vi.fn().mockResolvedValue(undefined)
      const api = {
        session: { ...window.api.session, set, flush: vi.fn().mockResolvedValue(undefined) },
        crossMachineRecovery: window.api.crossMachineRecovery
      }

      const reply = await handleCrossMachineRecoveryApplyRequest(store, api, {
        requestId: 'r1',
        op: { kind: 'import', importKey: 'key', fragment: plan.fragment, records }
      })
      store.getState().reconcileWorktreeTabModel(WT)

      expect(reply).toEqual({ requestId: 'r1', outcome: { ok: true, claimed: null } })
      expectEveryRecordReachable(store.getState(), records)

      const persisted: WorkspaceSessionState = structuredClone(set.mock.calls.at(-1)![0])
      const reloaded = destinationStore()
      reloaded.getState().hydrateWorkspaceSession(persisted)
      reloaded.getState().hydrateTabsSession(persisted)
      reconcileHydratedWorkspaceTabModels(persisted, reloaded.getState().reconcileWorktreeTabModels)
      expectEveryRecordReachable(reloaded.getState(), records)
    }
  )
})
