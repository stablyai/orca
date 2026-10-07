// why: the model hooks render through React DOM, so @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'

type RefreshCall = { worktreeId: string; worktreePath: string }
type GitCall = { worktreeId: string | null; worktreePath: string }

const recorded = vi.hoisted(() => {
  const refreshes: RefreshCall[] = []
  const stages: GitCall[] = []
  const commits: GitCall[] = []
  const discards: GitCall[] = []
  const pushes: GitCall[] = []
  return { refreshes, stages, commits, discards, pushes }
})

vi.mock('../../git-status-refresh', () => ({
  refreshGitStatusForWorktree: vi.fn(async (args: RefreshCall) => {
    recorded.refreshes.push({ worktreeId: args.worktreeId, worktreePath: args.worktreePath })
  })
}))

vi.mock('@/runtime/runtime-git-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stageRuntimeGitPath: vi.fn(async (context: GitCall) => {
    recorded.stages.push({ worktreeId: context.worktreeId, worktreePath: context.worktreePath })
  }),
  discardRuntimeGitPath: vi.fn(async (context: GitCall) => {
    recorded.discards.push({ worktreeId: context.worktreeId, worktreePath: context.worktreePath })
  }),
  commitRuntimeGit: vi.fn(async (context: GitCall) => {
    recorded.commits.push({ worktreeId: context.worktreeId, worktreePath: context.worktreePath })
    return { success: true }
  })
}))

import { SourceControlTargetProvider } from './source-control-target-worktree'
import { useSourceControlPanelModel } from './use-panel-model'

const initialAppState = useAppStore.getInitialState()
const worktreeA = makeWorktree({ id: 'repo1::/repo1', repoId: 'repo1', path: '/repo1' })
const worktreeB = makeWorktree({ id: 'repo1::/repo1-b', repoId: 'repo1', path: '/repo1-b' })
const stagedOnB: GitStatusEntry = {
  path: 'b.ts',
  area: 'staged',
  status: 'modified',
  added: 1,
  removed: 0
}
const unstagedOnA: GitStatusEntry = { ...stagedOnB, path: 'a.ts', area: 'unstaged' }

const confirmNothing = async (): Promise<boolean> => false

function ConfirmationWrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <ConfirmationDialogContext.Provider value={confirmNothing}>
      {children}
    </ConfirmationDialogContext.Provider>
  )
}

function targetWrapper(worktree: Worktree, isActive: boolean) {
  return function TargetWrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return (
      <ConfirmationWrapper>
        <SourceControlTargetProvider worktree={worktree} isActive={isActive}>
          {children}
        </SourceControlTargetProvider>
      </ConfirmationWrapper>
    )
  }
}

// why: the model's effects touch many preload namespaces; any call resolves to nothing
function installInertApi(): void {
  const method = new Proxy({}, { get: () => vi.fn(async () => undefined) })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy({}, { get: () => method })
  })
}

beforeEach(() => {
  recorded.refreshes.length = 0
  recorded.stages.length = 0
  recorded.commits.length = 0
  recorded.discards.length = 0
  recorded.pushes.length = 0
  installInertApi()
  useAppStore.setState(initialAppState, true)
  useAppStore.setState({
    activeWorktreeId: worktreeA.id,
    worktreesByRepo: { repo1: [worktreeA, worktreeB] },
    repos: [{ ...TEST_REPO, kind: 'git', connectionId: null }],
    gitStatusByWorktree: { [worktreeA.id]: [unstagedOnA], [worktreeB.id]: [stagedOnB] },
    rightSidebarOpen: true,
    rightSidebarTab: 'source-control',
    pushBranch: async (worktreeId: string, worktreePath: string) => {
      recorded.pushes.push({ worktreeId, worktreePath })
    }
  })
})

afterEach(cleanup)

describe('source control target worktree', () => {
  it('follows the active worktree without a provider', () => {
    const { result } = renderHook(() => useSourceControlPanelModel(), {
      wrapper: ConfirmationWrapper
    })

    expect(result.current.activeWorktreeId).toBe(worktreeA.id)
    expect(result.current.worktreePath).toBe('/repo1')
    expect(result.current.entries).toEqual([unstagedOnA])
    expect(result.current.isBranchVisible).toBe(true)
  })

  it('reads, refreshes, stages, commits, discards and pushes the target worktree, never the active one', async () => {
    const { result } = renderHook(() => useSourceControlPanelModel(), {
      wrapper: targetWrapper(worktreeB, true)
    })

    expect(result.current.activeWorktreeId).toBe(worktreeB.id)
    expect(result.current.worktreePath).toBe('/repo1-b')
    expect(result.current.entries).toEqual([stagedOnB])
    await waitFor(() => expect(recorded.refreshes.length).toBeGreaterThan(0))

    await act(async () => {
      await result.current.handleStage('b.ts')
    })
    await act(async () => {
      await result.current.handleCommit('message')
    })

    await act(async () => {
      await result.current.discardSingle('b.ts')
    })
    await act(async () => {
      await result.current.runRemoteAction('push')
    })

    expect(recorded.stages).toEqual([{ worktreeId: worktreeB.id, worktreePath: '/repo1-b' }])
    expect(recorded.discards).toEqual([{ worktreeId: worktreeB.id, worktreePath: '/repo1-b' }])
    expect(recorded.pushes).toEqual([{ worktreeId: worktreeB.id, worktreePath: '/repo1-b' }])
    expect(recorded.commits).toEqual([{ worktreeId: worktreeB.id, worktreePath: '/repo1-b' }])
    const touched = [
      ...recorded.refreshes,
      ...recorded.stages,
      ...recorded.commits,
      ...recorded.discards,
      ...recorded.pushes
    ]
    expect(touched.every((call) => call.worktreeId === worktreeB.id)).toBe(true)
    expect(useAppStore.getState().gitStatusByWorktree[worktreeA.id]).toEqual([unstagedOnA])
  })

  it('treats a collapsed-but-mounted target as hidden and polls nothing', () => {
    const { result } = renderHook(() => useSourceControlPanelModel(), {
      wrapper: targetWrapper(worktreeB, false)
    })

    expect(result.current.isBranchVisible).toBe(false)
    expect(recorded.refreshes).toEqual([])
  })
})
