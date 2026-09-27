import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '../../src/renderer/src/lib/agent-status'
import { projectPresentationView } from '../../src/renderer/src/lib/cross-machine-recovery-presentation-projection'
import { planRecoveryImport } from '../../src/main/runtime/cross-machine-recovery/recovery-import-plan'
import {
  descriptor,
  SOURCE_LEAF,
  SOURCE_TAB,
  withActiveAgentSessionTab,
  withPreferredClientView
} from '../../src/main/runtime/cross-machine-recovery/recovery-import.test-fixture'
import { OrcaRecoveryDescriptorV1Schema } from '../../src/shared/rpc-contract/cross-machine-recovery-params'
import { parsePaneKey } from '../../src/shared/stable-pane-id'
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

const SOURCE_WT = 'src-repo::/src/wt'
const WT = 'repo1::/repo1/wt'

describe('cross-machine recovery import of a projected client view', () => {
  it('keeps a Resume tab for a binding whose terminal row the groupless view retained', async () => {
    const view = projectPresentationView(
      {
        activeRepoId: null,
        activeWorktreeId: SOURCE_WT,
        activeTabId: null,
        tabsByWorktree: {
          [SOURCE_WT]: [
            {
              id: SOURCE_TAB,
              ptyId: 'pty-1',
              worktreeId: SOURCE_WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          [SOURCE_TAB]: {
            root: { type: 'leaf', leafId: SOURCE_LEAF },
            activeLeafId: SOURCE_LEAF,
            expandedLeafId: null
          }
        }
      },
      SOURCE_WT,
      '/src/wt'
    )
    expect(view.tabs).toEqual([])
    expect(view.groups).toEqual([])
    const parsed = OrcaRecoveryDescriptorV1Schema.safeParse(
      withPreferredClientView(withActiveAgentSessionTab(descriptor()), view)
    )
    expect(parsed.success).toBe(true)
    const plan = planRecoveryImport(parsed.data!, undefined, {
      worktreeId: WT,
      checkoutPath: '/repo1/wt',
      sourceWorkspacePath: '/src/wt',
      now: 1_000,
      mintId: () => randomUUID(),
      importKey: 'key',
      pathMap: [],
      sourceProviderSessionIds: new Map()
    })
    const store = createTestStore()
    store.setState({
      repos: [TEST_REPO],
      worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/repo1/wt' })] }
    })
    const api = {
      session: {
        ...window.api.session,
        set: vi.fn().mockResolvedValue(undefined),
        flush: vi.fn().mockResolvedValue(undefined)
      },
      crossMachineRecovery: window.api.crossMachineRecovery
    }
    const records = plan.bindings.flatMap((planned) => (planned.record ? [planned.record] : []))
    expect(plan.bindings.map((planned) => planned.result.status)).toEqual(['dormant', 'dormant'])

    const reply = await handleCrossMachineRecoveryApplyRequest(store, api, {
      requestId: 'r1',
      op: { kind: 'import', importKey: 'key', fragment: plan.fragment, records }
    })
    store.getState().reconcileWorktreeTabModel(WT)

    expect(reply).toEqual({ requestId: 'r1', outcome: { ok: true, claimed: null } })
    const state = store.getState()
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
  })
})
