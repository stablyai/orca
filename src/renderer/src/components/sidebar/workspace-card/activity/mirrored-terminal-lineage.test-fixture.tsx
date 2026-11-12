import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { act } from 'react'
import { expect, vi } from 'vitest'
import type { RuntimeAgentLineageTestModule } from '../../../../../../shared/runtime-agent-lineage-consumer.test-fixture'
import { isStructuredTab } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'

// Load the native graph during collection; fixture state stays per test.
const {
  default: { publicLineageFixture, canonicalChatRow, LINEAGE_PARENT, LINEAGE_CHILD }
} = await vi.importActual<{ default: RuntimeAgentLineageTestModule }>(
  '../../../../../../main/runtime/workspaces/process-listing/runtime-agent-lineage.test-fixture'
)

const LEAF = '11111111-1111-4111-8111-111111111111'

export async function verifyMirroredTerminalLineage(
  kind: 'default' | 'reserved' | 'collision',
  {
    patch,
    entry,
    mount,
    getRows
  }: {
    patch: (update: Partial<AppState>) => void
    entry: (key: string, worktree: string) => AgentStatusEntry
    mount: () => void
    getRows: () => DashboardAgentRow[]
  }
): Promise<void> {
  const { makeUnifiedTab } = await import('@/store/slices/tabs/tab-group.test-fixture'),
    { makeWorktree } = await import('@/store/slices/worktrees/worktree.test-fixture'),
    { TEST_REPO } = await import('@/store/repos/repo.test-fixture')
  const { buildActivityEvents } = await import('@/components/activity/activity-event-builder')
  const { buildMirroredAgentTabs } =
    await import('@/runtime/web-session-tabs-sync/terminal-surfaces')
  const { buildMirroredAgentStatusPatch } =
    await import('@/runtime/web-session-tabs-sync/agent-status-patch')
  const { buildTerminalUnifiedTab } = await import('@/runtime/web-session-tabs-sync/tab-builders')
  const { toRemoteRuntimePtyId } =
    await import('../../../../../../shared/remote-runtime/remote-runtime-pty-id')
  const { toWebTerminalSurfaceTabId } =
    await import('../../../../../../shared/workspace-layout/terminal-surface-id')
  const { projectStatus } =
    await import('@/components/native-chat/session/status/structured-agent-session-status-projection')
  const { structuredAgentSessionPaneKey: pane, structuredAgentSessionTabId: tabId } =
    await import('../../../../../../shared/agent-session/view/structured-agent-session-projection')
  const { selectVisibleAgentOrchestration } =
    await import('@/runtime/agent-orchestration/visible-agent-orchestration')
  const worktree = makeWorktree({ id: 'folder-a', repoId: TEST_REPO.id })
  patch({ repos: [TEST_REPO], worktreesByRepo: { [TEST_REPO.id]: [worktree] } })
  const f = publicLineageFixture('folder-a')
  try {
    const context = f.projection.buildByPaneKey()?.[canonicalChatRow(LINEAGE_CHILD)]
    if (!context) {
      throw new Error('Missing production context')
    }
    const native = buildMirroredAgentTabs(
      {
        worktree: 'folder-a',
        publicationEpoch: 'test',
        snapshotVersion: 1,
        activeGroupId: 'g',
        activeTabId: null,
        activeTabType: 'agent-session',
        tabs: [
          {
            type: 'agent-session',
            id: 'host-parent',
            title: 'Parent',
            sessionId: LINEAGE_PARENT,
            replacesSessionId: 'previous',
            agent: 'codex',
            isActive: false
          }
        ]
      },
      'runtime:paired',
      new Map(),
      'g',
      0,
      kind === 'default'
        ? []
        : [
            makeUnifiedTab({
              id: kind === 'reserved' ? 'reserved-parent' : tabId(LINEAGE_PARENT),
              entityId: kind === 'reserved' ? 'previous' : 'occupied',
              worktreeId: 'folder-a',
              groupId: 'g',
              contentType: 'agent-session'
            })
          ],
      Date.now()
    )[0].unifiedTab
    if (!isStructuredTab(native)) {
      throw new Error('Expected the mirrored native session tab')
    }
    const actualParent = pane(native.id, LINEAGE_PARENT)
    const tab = makeTab({
      id: toWebTerminalSurfaceTabId('host-terminal'),
      worktreeId: 'folder-a',
      ptyId: toRemoteRuntimePtyId('terminal', 'paired')
    })
    const worker = makePaneKey(tab.id, LEAF)
    const terminal = buildTerminalUnifiedTab(tab, 'g', 'paired')
    patch({
      tabsByWorktree: { 'folder-a': [tab] },
      unifiedTabsByWorktree: {},
      ptyIdsByTabId: {},
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),

      runtimeAgentOrchestrationByPaneKey: {}
    })
    const produced = buildMirroredAgentStatusPatch(
      useAppStore.getState(),
      [],
      [
        {
          type: 'terminal',
          id: 'surface',
          title: 'Worker',
          parentTabId: 'host-terminal',
          leafId: LEAF,
          terminal: 'terminal',
          status: 'ready',
          isActive: false,
          agentStatus: {
            ...entry(makePaneKey('host-terminal', LEAF), 'folder-a'),
            orchestration: context
          }
        }
      ],
      [],
      'paired',
      'folder-a',
      new Set(),
      Date.now()
    )
    if (!produced) {
      throw new Error('Missing mirrored terminal status')
    }
    patch(produced)
    expect(useAppStore.getState().agentStatusByPaneKey.get(worker)!.connectionId).toBe('paired')
    // Status before graph: the missing parent stays rooted, then tab hydration alone joins it.
    expect(selectVisibleAgentOrchestration(useAppStore.getState())[worker]?.parentPaneKey).not.toBe(
      actualParent
    )
    patch({ unifiedTabsByWorktree: { 'folder-a': [native, terminal] } })
    act(() =>
      useAppStore.getState().transactAgentStatuses((transaction) =>
        projectStatus(
          transaction,
          native,
          {
            sessionId: LINEAGE_PARENT,
            workspaceId: 'folder-a',
            agent: 'codex',
            status: 'working',
            latestPrompt: 'Parent',
            updatedAt: Date.now(),
            hostExecutionOwned: true
          },
          'live',
          null
        )
      )
    )
    mount()
    const assertNested = (parent = actualParent) => {
      expect(getRows().map((row) => row.paneKey)).toEqual([parent, worker])
      expect(getRows().map((row) => row.lineage?.depth)).toEqual([0, 1])
      expect(getRows()[1].entry.orchestration?.parentPaneKey).toBe(parent)
      expect(
        useAppStore.getState().agentStatusByPaneKey.get(worker)?.orchestration?.parentPaneKey ??
          context.parentPaneKey
      ).toBe(canonicalChatRow(LINEAGE_PARENT))
      const state = useAppStore.getState()
      const dashboard = state.agentStatusByPaneKey.projection.list('folder-a')
      expect(dashboard.map((row) => [row.paneKey, row.lineage?.depth])).toEqual([
        [parent, 0],
        [worker, 1]
      ])
      const activity = buildActivityEvents({
        ...state,
        chatNames: new Map(),
        worktreeMap: new Map([[worktree.id, worktree]]),
        repoMap: new Map([[TEST_REPO.id, TEST_REPO]]),
        runtimeAgentOrchestrationByPaneKey: selectVisibleAgentOrchestration(state),
        now: Date.now()
      })
      expect(activity.paneEntryByPaneKey[worker]?.orchestration?.parentPaneKey).toBe(parent)
      expect(activity.paneEntryByPaneKey[parent]).toBeDefined()
    }
    assertNested()
    // A host-supplied legacy connection spelling does not override actual producer proof.
    patch({
      agentStatusByPaneKey: acceptedAgentStatuses([
        ...useAppStore.getState().agentStatusByPaneKey,
        [
          worker,
          {
            ...useAppStore.getState().agentStatusByPaneKey.get(worker)!,
            connectionId: 'ssh-legacy'
          }
        ] satisfies [string, AgentStatusEntry]
      ])
    })
    assertNested()
    const canonical = useAppStore.getState().agentStatusByPaneKey.get(worker)!
    // Graph before parent hydration; matching task/Dispatch producer remains valid with nonempty connectionId.
    const parentEntry = useAppStore.getState().agentStatusByPaneKey.get(actualParent)!
    patch({
      unifiedTabsByWorktree: { 'folder-a': [terminal] },
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({ [worker]: canonical }))
    })
    act(() =>
      useAppStore
        .getState()
        .setRuntimeAgentOrchestrationByPaneKey(
          { [worker]: structuredClone(context) },
          'runtime:paired'
        )
    )
    expect(getRows().find((row) => row.paneKey === worker)?.lineage?.depth).toBe(0)
    patch({
      unifiedTabsByWorktree: { 'folder-a': [native, terminal] },
      agentStatusByPaneKey: acceptedAgentStatuses(
        Object.entries({ [worker]: canonical, [actualParent]: parentEntry })
      )
    })
    assertNested()
    act(() => useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey({}))
    // PTY-only hydration is an independent cache input; disagreeing tab/PTY facts must not join.
    patch({
      unifiedTabsByWorktree: { 'folder-a': [native] },
      tabsByWorktree: { 'folder-a': [{ ...tab, ptyId: null }] }
    })
    expect(getRows().find((row) => row.paneKey === worker)?.lineage?.depth).toBe(0)
    patch({ ptyIdsByTabId: { [tab.id]: [tab.ptyId ?? ''] } })
    assertNested()
    patch({
      unifiedTabsByWorktree: {
        'folder-a': [native, { ...terminal, executionHostId: 'runtime:other' }]
      }
    })
    expect(getRows().find((row) => row.paneKey === worker)?.lineage?.depth).toBe(0)
    patch({
      unifiedTabsByWorktree: {
        'folder-a': [{ ...native, executionHostId: 'runtime:other' }, terminal]
      },
      ptyIdsByTabId: {}
    })
    expect(getRows().find((row) => row.paneKey === worker)?.lineage?.depth).toBe(0)
    patch({ unifiedTabsByWorktree: { 'folder-a': [native, terminal] } })
    assertNested()
    // Matching graph context identifies its producer even when terminal routing names another host.
    const renamedParent = actualParent
    patch({
      tabsByWorktree: { 'folder-a': [tab] },
      unifiedTabsByWorktree: {
        'folder-a': [{ ...native, executionHostId: 'local' }, terminal]
      },
      agentStatusByPaneKey: acceptedAgentStatuses(
        Object.entries({
          [renamedParent]: useAppStore.getState().agentStatusByPaneKey.get(renamedParent)!,
          [worker]: canonical
        })
      )
    })
    act(() =>
      useAppStore
        .getState()
        .setRuntimeAgentOrchestrationByPaneKey({ [worker]: structuredClone(context) })
    )
    assertNested(renamedParent)
    act(() =>
      useAppStore
        .getState()
        .setRuntimeAgentOrchestrationByPaneKey(
          { [worker]: structuredClone(context) },
          'runtime:other'
        )
    )
    expect(getRows().find((row) => row.paneKey === worker)?.lineage?.depth).toBe(0)
    act(() => useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey({}))
    patch({
      tabsByWorktree: { 'folder-a': [{ ...tab, ptyId: 'remote:%zz@@terminal' }] },
      unifiedTabsByWorktree: {
        'folder-a': [{ ...native, executionHostId: 'local' }]
      },
      agentStatusByPaneKey: acceptedAgentStatuses([
        ...useAppStore.getState().agentStatusByPaneKey,
        [worker, { ...canonical, connectionId: undefined }] satisfies [string, AgentStatusEntry]
      ])
    })
    expect(getRows().find((row) => row.paneKey === worker)?.lineage?.depth).toBe(0)
  } finally {
    f.db.close()
  }
}
