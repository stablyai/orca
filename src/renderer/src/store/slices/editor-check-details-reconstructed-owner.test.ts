import { expect, it, vi } from 'vitest'
import { createCheckRunDetailsRequestId } from '@/components/editor/check-run-details-tab'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { makeWorktree, TEST_REPO } from './worktrees-slice-test-fixtures'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { publishedLayoutsOf } from '@/runtime/main-loaded-layout-frames.test-fixture'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { buildLayoutFrameSlices } from '../workspace-layout-frame-slices'
import { loadWorkspaceLayoutWithoutReport } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN).each(['local', 'ssh:builder'] as const)(
  'refreshes reconstructed %s checks and isolates colliding requests from its runtime twin',
  async (hostId) => {
    const repo = {
      ...TEST_REPO,
      id: 'repo-1',
      path: '/owner',
      executionHostId: hostId,
      connectionId: hostId === 'local' ? null : 'builder'
    }
    const workspace = makeWorktree({ id: 'wt-1', repoId: repo.id, path: repo.path, hostId })
    const catalog = {
      repos: [
        repo,
        { ...repo, path: '/rival', executionHostId: 'runtime:server' as const, connectionId: null }
      ],
      worktreesByRepo: {
        [repo.id]: [
          workspace,
          {
            ...workspace,
            path: '/rival',
            hostId: 'runtime:server' as const,
            runtimeOwnerEnvironmentId: 'server'
          }
        ]
      }
    }
    const source = createEditorTabsStore()
    const fetchPRCheckDetails = vi.fn().mockResolvedValue(null)
    source.setState({ ...catalog, activeWorkspaceExecutionHostId: hostId, fetchPRCheckDetails })
    const sourceFrames = await drawTabsFromMain(source)
    const model = layoutApplyTestTransport.mainModel!
    layoutApplyTestTransport.useMainModel({ ...model, hostId })
    source.getState().openCheckRunDetails(
      workspace.id,
      'repo:99',
      {
        name: 'verify',
        status: 'completed',
        conclusion: 'failure',
        url: null,
        checkRunId: 42
      },
      { requestId: createCheckRunDetailsRequestId(), details: null, loading: false, error: null }
    )
    await sourceFrames.settle()
    const fileId = source.getState().openFiles[0]!.id
    await source.getState().reloadOpenCheckRunDetailsTab(fileId)
    expect(fetchPRCheckDetails).toHaveBeenCalledWith('/owner', expect.anything(), {
      repoId: repo.id,
      repoOwnerExecutionHostId: hostId
    })
    const layouts = publishedLayoutsOf(layoutApplyTestTransport.mainModel!)
    expect(layouts[workspace.id]!.tabs[0]!.executionHostId).toBe(hostId)
    const { facts, desktopView } = loadWorkspaceLayoutWithoutReport(
      hostId,
      buildWorkspaceSessionPayload(source.getState()),
      nameBasedLoadContext()
    )
    try {
      const restored = createEditorTabsStore()
      restored.setState({
        ...buildLayoutFrameSlices({ layouts, facts, view: desktopView }),
        ...catalog,
        activeWorkspaceExecutionHostId: 'runtime:server',
        fetchPRCheckDetails
      })
      expect(restored.getState().openFiles).toHaveLength(1)
      const previous = restored.getState().openFiles[0]!.checkRunDetails!
      restored.getState().openCheckRunDetails(workspace.id, previous.contextKey, previous.check, {
        requestId: previous.requestId,
        details: null,
        loading: true,
        error: null
      })
      expect(previous.requestId).toEqual(expect.any(Number))
      const runtimeTabId = restored.getState().activeFileId
      expect(runtimeTabId).not.toBe(fileId)
      restored.setState({ activeWorkspaceExecutionHostId: hostId })
      restored
        .getState()
        .patchOpenCheckRunDetails(workspace.id, previous.contextKey, previous.check, {
          requestId: previous.requestId,
          details: null,
          loading: false,
          error: 'Runtime request completed'
        })
      expect(
        restored.getState().openFiles.find((file) => file.id === runtimeTabId)?.checkRunDetails
      ).toMatchObject({ loading: false, error: 'Runtime request completed' })
      expect(
        restored.getState().openFiles.find((file) => file.id === fileId)?.checkRunDetails
      ).toEqual(previous)

      fetchPRCheckDetails.mockClear()
      await restored.getState().reloadOpenCheckRunDetailsTab(fileId)
      expect(fetchPRCheckDetails).toHaveBeenCalledWith('/owner', expect.anything(), {
        repoId: repo.id,
        repoOwnerExecutionHostId: hostId
      })
      restored.setState({
        repos: [catalog.repos[1]!],
        worktreesByRepo: { [repo.id]: [catalog.worktreesByRepo[repo.id]![1]!] }
      })
      fetchPRCheckDetails.mockClear()
      await restored.getState().reloadOpenCheckRunDetailsTab(fileId)
      expect(fetchPRCheckDetails).not.toHaveBeenCalled()
      expect(restored.getState().openFiles[0]!.checkRunDetails?.error).toBe(
        'Repository details are unavailable for this check.'
      )
    } finally {
      sourceFrames.close()
    }
  }
)
