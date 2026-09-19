import { describe, it, expect, vi, beforeEach } from 'vitest'
import { toast } from 'sonner'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { createAutomationRunWorkspaceAction } from './automation-run-workspace-action'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationsPageActionContext } from './automations-page-action-context'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), message: vi.fn() }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

const mockGetState = vi.fn()
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockGetState() }
}))

// Regression coverage for #21213: a run dispatched on a paired remote runtime carries
// pane-key/pty-id metadata the local window's tab/layout/pty ledgers can never resolve,
// so View run used to dead-end with "Run terminal is unavailable." even though
// activating the run's workspace surfaces the live session.
describe('openRunWorkspace pane-key resolution failure', () => {
  const selectedRow = { key: 'row-1' }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial run fixture; openRunWorkspace only reads the id/workspace/pane-key fields stubbed here.
  const run = {
    id: 'run-1',
    automationId: 'automation-1',
    status: 'completed',
    workspaceId: 'wt-1',
    terminalPaneKey: 'tab-1:6bcf637a-03b4-44fe-899b-f3b8c1bbe987',
    terminalPtyId: 'pty-1'
  } as unknown as AutomationRun

  function buildContext(
    repo: Record<string, unknown> = { id: 'repo-1' },
    worktree: Record<string, unknown> = { id: 'wt-1' }
  ): AutomationsPageActionContext {
    const stub = {
      store: {
        repoForRow: () => repo,
        worktreeForRow: (_row: unknown, _repo: unknown, workspaceId: string) =>
          workspaceId === 'wt-1' ? worktree : null
      },
      list: { selectedRow }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial context stub; the action destructures only repoForRow/worktreeForRow/selectedRow and the stub supplies all three.
    return stub as unknown as AutomationsPageActionContext
  }

  const openAction = createAutomationRunWorkspaceAction(buildContext())

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetState.mockReturnValue({
      getTab: () => undefined,
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      setTabLayout: vi.fn(),
      setActiveTab: vi.fn(),
      setActiveTabType: vi.fn()
    })
  })

  it('activates the run workspace instead of dead-ending when the pane key cannot be resolved', () => {
    vi.mocked(activateAndRevealWorktree).mockReturnValue({ primaryTabId: null })

    openAction(run)

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('still surfaces the unavailable label when the workspace cannot be activated', () => {
    vi.mocked(activateAndRevealWorktree).mockReturnValue(false)

    openAction(run)

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    expect(toast.error).toHaveBeenCalledWith('Run terminal is unavailable.')
  })

  it('still focuses the exact pane when local resolution succeeds', () => {
    const setTabLayout = vi.fn()
    const setActiveTab = vi.fn()
    mockGetState.mockReturnValue({
      getTab: () => ({ id: 'tab-1' }),
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: '6bcf637a-03b4-44fe-899b-f3b8c1bbe987' },
          ptyIdsByLeafId: {}
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      setTabLayout,
      setActiveTab,
      setActiveTabType: vi.fn()
    })
    vi.mocked(activateAndRevealWorktree).mockReturnValue({ primaryTabId: 'tab-1' })

    openAction(run)

    expect(setTabLayout).toHaveBeenCalled()
    expect(setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('activates through the run execution host so a same-id local twin cannot shadow the remote session', () => {
    vi.mocked(activateAndRevealWorktree).mockReturnValue({ primaryTabId: null })
    const openRuntimeRun = createAutomationRunWorkspaceAction(
      buildContext(
        { id: 'repo-1', executionHostId: 'runtime:env-7' },
        { id: 'wt-1', hostId: 'runtime:env-7' }
      )
    )

    openRuntimeRun(run)

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      executionHostId: 'runtime:env-7'
    })
    expect(toast.error).not.toHaveBeenCalled()
  })
})
