// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { RuntimeRepoSearchRefs } from '../../../../../../shared/runtime-worktree-contracts'
import { useBranchPicker, type BranchPickerOptions } from './use-branch-picker'
import type { BranchWorkspace } from './branch-picker-rows'
import {
  listRuntimeGitBranches,
  searchRuntimeRemoteBranches
} from '@/runtime/runtime-git-branch-client'
vi.mock('@/runtime/runtime-git-branch-client', () => ({
  listRuntimeGitBranches: vi.fn(),
  searchRuntimeRemoteBranches: vi.fn(),
  switchRuntimeGitBranch: vi.fn(),
  branchSwitchExistingBranch: vi.fn()
}))
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

it.each([100, 1000])(
  'bounds picker work for %i branches and workspaces by its open and debounce triggers',
  async (size) => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    let workspaceVisits = 0
    let branchVisits = 0
    const makeWorkspaces = () =>
      new Map(
        Array.from({ length: size }, (_, n): [string, BranchWorkspace] => [
          String(n),
          {
            id: String(n),
            repoId: 'repo',
            get path() {
              workspaceVisits += 1
              return `/workspace/${n}`
            }
          }
        ])
      )
    const branches = Array.from({ length: size }, (_, n) => `branch-${n}`)
    const worktreePaths: Record<string, string> = new Proxy(
      {},
      {
        get: (_, key) => {
          branchVisits += 1
          return `/workspace/${String(key).slice(7)}`
        },
        getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true })
      }
    )
    vi.mocked(listRuntimeGitBranches).mockResolvedValue({
      current: 'main',
      branches,
      worktreePaths
    })
    vi.mocked(searchRuntimeRemoteBranches).mockResolvedValue({ refs: [], truncated: false })
    const options: BranchPickerOptions = {
      context: { target: { kind: 'local' }, worktreeId: 'repo::/repo', worktreePath: '/repo' },
      hostId: 'local',
      hostLabel: 'This computer',
      repoId: 'repo',
      workspaces: makeWorkspaces(),
      onSwitched: vi.fn(),
      onOpenWorkspace: vi.fn()
    }
    let picker: ReturnType<typeof useBranchPicker> | undefined
    function Probe({ workspaces }: { workspaces: ReadonlyMap<string, BranchWorkspace> }) {
      picker = useBranchPicker({ ...options, workspaces })
      return null
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => root.render(<Probe workspaces={options.workspaces} />))
      const next = makeWorkspaces()
      await act(async () => root.render(<Probe workspaces={next} />))
      expect(workspaceVisits).toBe(0)
      expect(listRuntimeGitBranches).not.toHaveBeenCalled()
      await act(async () => picker?.setOpen(true))
      expect(listRuntimeGitBranches).toHaveBeenCalledOnce()
      expect(workspaceVisits).toBe(size)
      expect(branchVisits).toBe(size)
      await act(async () => vi.advanceTimersByTimeAsync(200))
      expect(searchRuntimeRemoteBranches).toHaveBeenCalledTimes(1)
      let resolveStale: ((page: RuntimeRepoSearchRefs) => void) | undefined
      vi.mocked(searchRuntimeRemoteBranches).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStale = resolve
          })
      )
      await act(async () => picker?.setQuery('stale'))
      await act(async () => vi.advanceTimersByTimeAsync(200))
      await act(async () => {
        picker?.setQuery('f')
        picker?.setQuery('fe')
        picker?.setQuery('feature')
      })
      await act(async () => vi.advanceTimersByTimeAsync(200))
      await act(async () =>
        resolveStale?.({
          refs: [],
          refDetails: [{ refName: 'origin/stale', localBranchName: 'stale' }],
          truncated: false
        })
      )
      expect(picker?.rows.map((row) => row.target)).toEqual([{ kind: 'new', name: 'feature' }])
      // One initial query + two completed debounce windows, regardless of B or W.
      expect(searchRuntimeRemoteBranches).toHaveBeenCalledTimes(3)
      expect(listRuntimeGitBranches).toHaveBeenCalledOnce()
      expect(workspaceVisits).toBe(size)
      expect(branchVisits).toBe(size)
      await act(async () => picker?.setOpen(false))
      await act(async () => root.render(<Probe workspaces={makeWorkspaces()} />))
      expect(workspaceVisits).toBe(size)
    } finally {
      await act(async () => root.unmount())
      vi.useRealTimers()
    }
  }
)
