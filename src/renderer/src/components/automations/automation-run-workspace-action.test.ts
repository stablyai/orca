import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { createWorktreeIdentity } from '../../../../shared/worktree/identity'
import { useAppStore } from '@/store'
import { selectKnownWorktreeById, selectRepoByIdForActiveWorkspace } from '@/store/selectors'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { repoWithFetchedOwner } from '../../store/repos/owner-routing'
import { withRepoHostOwnership } from '../../store/slices/worktrees/listing/worktree-host-ownership'
import {
  makeAutomation,
  makeAutomationListRow,
  makeRun,
  makeWorktree
} from './automations-page-fixtures'
import {
  automationRepoForRow,
  automationWorktreeForRow,
  type AutomationListRow
} from './automation-list-row-identity'
import { createAutomationRunWorkspaceAction } from './automation-run-workspace-action'

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn(() => null)
}))
vi.mock('@/lib/resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: vi.fn()
}))
vi.mock('@/lib/web-runtime-worktree-terminal-after-wake', () => ({
  ensureWebRuntimeWorktreeTerminalAfterWake: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

const initial = useAppStore.getState()
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  useAppStore.setState(initial, true)
})

function producer(publisher: string, rawHost: ExecutionHostId) {
  const raw: Repo = {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: 'blue',
    addedAt: 1,
    executionHostId: rawHost
  }
  const instanceId = `${publisher}-${rawHost}`
  const target =
    publisher === 'local'
      ? ({ kind: 'local' } as const)
      : ({ kind: 'environment', environmentId: publisher } as const)
  return {
    repo: repoWithFetchedOwner(raw, target),
    workspace: withRepoHostOwnership(
      makeWorktree({
        id: 'repo-1::/repo/child-checkout',
        path: '/repo/child-checkout',
        hostId: rawHost,
        instanceId,
        identity: createWorktreeIdentity({
          worktreeId: 'repo-1::/repo/child-checkout',
          executionHostId: rawHost,
          instanceId
        })
      }),
      publisher === 'local' ? 'local' : toRuntimeExecutionHostId(publisher)
    )
  }
}

function installOpenAction(
  owners: ReturnType<typeof producer>[],
  selected: ReturnType<typeof producer>,
  options: { missingRepo?: boolean; duplicate?: boolean; unscoped?: boolean } = {}
) {
  const repos = owners.map((owner) => owner.repo)
  const rows = owners.map((owner) => owner.workspace)
  if (options.duplicate) {
    rows.push({ ...selected.workspace, instanceId: 'duplicate' })
  }
  const row: AutomationListRow = {
    ...makeAutomationListRow({
      automation: makeAutomation({
        workspaceMode: 'existing',
        workspaceId: selected.workspace.id,
        runContext: {
          kind: 'workspace-run',
          projectId: 'project-1',
          projectHostSetupId: 'setup-1',
          repoId: selected.repo.id,
          hostId:
            selected.repo.authoritativeExecutionHostId ?? getRepoExecutionHostId(selected.repo),
          path: selected.repo.path
        }
      })
    }),
    catalogRef: options.unscoped
      ? null
      : {
          authority: selected.workspace.runtimeOwnerEnvironmentId
            ? { kind: 'runtime', environmentId: selected.workspace.runtimeOwnerEnvironmentId }
            : { kind: 'desktop' },
          selector:
            selected.workspace.hostId === 'local'
              ? { kind: 'self' }
              : { kind: 'ssh', targetId: 'selected' }
        }
  }
  useAppStore.setState({
    repos,
    worktreesByRepo: { 'repo-1': rows },
    detectedWorktreesByRepo: {},
    activeWorktreeId: null,
    activeRepoId: null,
    activeWorkspaceOwner: null,
    activeView: 'settings',
    refreshGitHubForWorktreeIfStale: vi.fn()
  })
  const legacy = owners[0]
  if (!legacy) {
    throw new Error('Missing bootstrap fixture')
  }
  return createAutomationRunWorkspaceAction({
    store: {
      repoForRow: (candidate) =>
        automationRepoForRow(
          candidate,
          options.missingRepo ? [] : repos,
          new Map([[selected.repo.id, legacy.repo]])
        ),
      worktreeForRow: (candidate, repo, id) =>
        automationWorktreeForRow(
          candidate,
          { 'repo-1': rows },
          repo,
          new Map([[selected.workspace.id, legacy.workspace]]),
          id
        )
    },
    list: { selectedRow: row }
  })
}

describe('automation run opening through real selection and routing', () => {
  it.each([false, true])('opens the selected SSH sibling (reversed: %s)', (reversed) => {
    const local = producer('local', 'local')
    const selected = producer('local', 'ssh:b')
    const owners = reversed ? [selected, local] : [local, selected]
    const open = installOpenAction(owners, selected)
    open(makeRun({ workspaceId: selected.workspace.id }))
    const state = useAppStore.getState()
    expect(selectKnownWorktreeById(state, selected.workspace.id)).toBe(selected.workspace)
    expect(selectRepoByIdForActiveWorkspace(state, selected.repo.id)).toBe(selected.repo)
    expect(state.activeWorkspaceOwner).toMatchObject({ executionHostId: 'ssh:b' })
    expect(resolveWorktreeOperationRouteResult(state, selected.workspace.id)).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'ssh:b', runtimeEnvironmentId: null }
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'opens the selected private SSH publisher under both alias collisions (reversed: %s)',
    (reversed) => {
      const selected = producer('publisher-b', 'ssh:b')
      const owners = [
        producer('publisher-a', 'ssh:a'),
        producer('publisher-a', 'ssh:b'),
        producer('publisher-b', 'ssh:a'),
        selected
      ]
      const open = installOpenAction(reversed ? owners.toReversed() : owners, selected)
      open(makeRun({ workspaceId: selected.workspace.id }))
      const state = useAppStore.getState()
      expect(selectKnownWorktreeById(state, selected.workspace.id)).toBe(selected.workspace)
      expect(selectRepoByIdForActiveWorkspace(state, selected.repo.id)).toBe(selected.repo)
      expect(state.activeWorkspaceOwner).toEqual({
        worktreeId: selected.workspace.id,
        publisherHostId: 'runtime:publisher-b',
        executionHostId: 'ssh:b',
        instanceId: 'publisher-b-ssh:b'
      })
      expect(resolveWorktreeOperationRouteResult(state, selected.workspace.id)).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'ssh:b', runtimeEnvironmentId: 'publisher-b' }
      })
      expect(toast.error).not.toHaveBeenCalled()
    }
  )

  it.each([{ missingRepo: true }, { duplicate: true }])(
    'refuses a captured target instead of its poisoned bare fallback (%j)',
    (options) => {
      const sibling = producer('local', 'local')
      const selected = producer('publisher', 'ssh:b')
      const open = installOpenAction([sibling, selected], selected, options)
      open(makeRun({ workspaceId: selected.workspace.id }))
      expect(useAppStore.getState().activeWorktreeId).toBeNull()
      expect(useAppStore.getState().activeView).toBe('settings')
      expect(toast.error).toHaveBeenCalledWith('Workspace no longer available')
    }
  )

  it('keeps an unscoped unique local bootstrap runnable', () => {
    const selected = producer('local', 'local')
    const open = installOpenAction([selected], selected, { unscoped: true })
    open(makeRun({ workspaceId: selected.workspace.id }))
    expect(useAppStore.getState().activeWorktreeId).toBe(selected.workspace.id)
    expect(
      resolveWorktreeOperationRouteResult(useAppStore.getState(), selected.workspace.id)
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
    expect(toast.error).not.toHaveBeenCalled()
  })
})
