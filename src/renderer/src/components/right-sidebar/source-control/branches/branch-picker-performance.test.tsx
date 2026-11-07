// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BranchPicker, type BranchPickerProps } from './BranchPicker'
import type * as Rows from './branch-picker-rows'
import type { BranchWorkspace } from './branch-picker-rows'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

const counts = vi.hoisted(() => ({ renders: 0, builds: 0, iterations: 0 }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('./branch-picker-rows', async (original) => {
  const actual = await original<typeof Rows>()
  class ObservedIndex extends Map<string, BranchWorkspace> {
    override *keys(): MapIterator<string> {
      for (const key of super.keys()) {
        counts.iterations++
        yield key
      }
      return undefined
    }
    override *values(): MapIterator<BranchWorkspace> {
      for (const value of super.values()) {
        counts.iterations++
        yield value
      }
      return undefined
    }
    override *entries(): MapIterator<[string, BranchWorkspace]> {
      for (const entry of super.entries()) {
        counts.iterations++
        yield entry
      }
      return undefined
    }
    override [Symbol.iterator]() {
      return this.entries()
    }
    override forEach(
      callback: (value: BranchWorkspace, key: string, map: Map<string, BranchWorkspace>) => void
    ) {
      for (const [key, value] of this) {
        callback(value, key, this)
      }
    }
  }
  return {
    ...actual,
    indexBranchWorkspaces: (...args: Parameters<typeof actual.indexBranchWorkspaces>) => {
      const index = actual.indexBranchWorkspaces(...args)
      if (!index) {
        return null
      }
      counts.builds++
      return new ObservedIndex(index)
    }
  }
})
vi.mock('@/components/ui/popover', () => ({
  Popover: ({
    children,
    onOpenChange
  }: {
    children: ReactNode
    onOpenChange: (open: boolean) => void
  }) => (
    <>
      <button data-open onClick={() => onOpenChange(true)}>
        Open
      </button>
      <button data-close onClick={() => onOpenChange(false)}>
        Close
      </button>
      {children}
    </>
  ),
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: ReactNode }) => <>{children}</>,
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandInput: ({ onValueChange }: { onValueChange: (query: string) => void }) => (
    <>
      <button data-stale onClick={() => onValueChange('stale')}>
        Stale query
      </button>
      <button data-query onClick={() => onValueChange('branch-9')}>
        Type
      </button>
    </>
  ),
  CommandItem: ({ children }: { children: ReactNode }) => {
    counts.renders++
    return <div data-row>{children}</div>
  }
}))
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
it.each([100, 1000])('bounds rendered picker work for %i branches and workspaces', async (size) => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  counts.renders = counts.builds = counts.iterations = 0
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
            workspaceVisits++
            return `/workspace/${n}`
          }
        }
      ])
    )
  const branches = Array.from({ length: size }, (_, n) => `branch-${n}`)
  vi.mocked(callRuntimeRpc)
    .mockResolvedValue({
      refs: [],
      refDetails: Array.from({ length: 200 }, (_, n) => ({
        refName: `origin/remote-${n}`,
        localBranchName: `remote-${n}`
      })),
      truncated: true
    })
    .mockResolvedValueOnce({
      current: 'branch-0',
      branches,
      worktreePaths: new Proxy<Record<string, string>>(
        Object.fromEntries(branches.map((name, n) => [name, `/workspace/${n}`])),
        {
          get(target, key) {
            branchVisits++
            return typeof key === 'string' ? target[key] : undefined
          }
        }
      )
    })
  const props: BranchPickerProps = {
    branch: 'branch-0',
    blocker: null,
    context: { target: { kind: 'local' }, worktreeId: 'repo::/repo', worktreePath: '/repo' },
    repoId: 'repo',
    hostId: 'local',
    hostLabel: 'This computer',
    workspaceLabel: 'repo',
    workspaces: makeWorkspaces(),
    onOpenWorkspace: vi.fn(),
    onSwitched: vi.fn()
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  const click = (selector: string) => {
    container.querySelector<HTMLButtonElement>(selector)?.click()
  }
  try {
    await act(async () => root.render(<BranchPicker {...props} context={{ ...props.context }} />))
    expect(counts.builds).toBe(0)
    expect(workspaceVisits).toBe(0)
    await act(async () => click('[data-open]'))
    expect(counts.builds).toBe(1)
    expect(workspaceVisits).toBe(size)
    expect(branchVisits).toBe(size)
    // The open window shows 50 local matches, regardless of catalog size.
    expect(container.querySelectorAll('[data-row]')).toHaveLength(50)
    counts.renders = 0
    await act(async () => root.render(<BranchPicker {...props} context={{ ...props.context }} />))
    expect(counts.renders).toBe(0)
    expect(counts.builds).toBe(1)
    const next = makeWorkspaces()
    await act(async () =>
      root.render(<BranchPicker {...props} context={{ ...props.context }} workspaces={next} />)
    )
    expect(counts.builds).toBe(2)
    expect(workspaceVisits).toBe(size * 2)
    expect(branchVisits).toBe(size * 2)
    counts.renders = 0
    await act(async () =>
      root.render(<BranchPicker {...props} context={{ ...props.context }} workspaces={next} />)
    )
    expect(counts.renders).toBe(0)
    expect(counts.builds).toBe(2)
    expect(counts.iterations).toBe(0)
    await act(async () => vi.advanceTimersByTimeAsync(200))
    counts.renders = 0
    await act(async () =>
      root.render(<BranchPicker {...props} context={{ ...props.context }} workspaces={next} />)
    )
    expect(counts.renders).toBe(0)
    let resolveStale: ((value: unknown) => void) | undefined
    vi.mocked(callRuntimeRpc).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStale = resolve
      })
    )
    await act(async () => click('[data-stale]'))
    await act(async () => vi.advanceTimersByTimeAsync(200))
    counts.renders = 0
    await act(async () => click('[data-query]'))
    // A keystroke can replace at most the 100 visible local/remote/create rows.
    expect(counts.renders).toBeLessThanOrEqual(100)
    expect(container.querySelectorAll('[data-row]').length).toBeLessThanOrEqual(100)
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(counts.renders).toBeLessThanOrEqual(100)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(4)
    expect(container.querySelectorAll('[data-row]').length).toBeLessThanOrEqual(100)
    // Exercise the production remote client: one remote-only bounded request per debounce.
    expect(callRuntimeRpc).toHaveBeenLastCalledWith(props.context.target, 'repo.searchRefs', {
      repo: 'repo',
      query: 'branch-9',
      namespace: 'remote',
      limit: 50
    })
    await act(async () =>
      resolveStale?.({
        refs: ['origin/stale'],
        refDetails: [{ refName: 'origin/stale', localBranchName: 'stale' }],
        truncated: false
      })
    )
    expect(container.textContent).not.toContain('origin/stale')
    expect(counts.iterations).toBe(0)
    expect(branchVisits).toBe(size * 2)
    await act(async () => click('[data-close]'))
    await act(async () =>
      root.render(
        <BranchPicker {...props} context={{ ...props.context }} workspaces={makeWorkspaces()} />
      )
    )
    expect(counts.builds).toBe(2)
    expect(workspaceVisits).toBe(size * 2)
    expect(branchVisits).toBe(size * 2)
  } finally {
    await act(async () => root.unmount())
    vi.useRealTimers()
  }
})
