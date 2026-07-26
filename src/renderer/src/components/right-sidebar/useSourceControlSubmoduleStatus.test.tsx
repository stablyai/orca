// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getRuntimeGitSubmoduleStatus: vi.fn() }))

vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitSubmoduleStatus: mocks.getRuntimeGitSubmoduleStatus
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))

import {
  useSourceControlSubmoduleStatus,
  type UseSourceControlSubmoduleStatusResult
} from './useSourceControlSubmoduleStatus'
import type { GitStatusEntry } from '../../../../shared/types'

const roots: Root[] = []

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

let latest: UseSourceControlSubmoduleStatusResult | null = null

function Probe({
  worktreeId,
  worktreePath,
  entries,
  settings = null
}: {
  worktreeId: string
  worktreePath: string
  entries: GitStatusEntry[]
  settings?: { activeRuntimeEnvironmentId: string | null } | null
}): null {
  latest = useSourceControlSubmoduleStatus({
    activeWorktreeId: worktreeId,
    worktreePath,
    activeRepoSettings: settings,
    entries
  })
  return null
}

function innerEntry(path: string): GitStatusEntry {
  return { path, status: 'modified', area: 'unstaged' } as GitStatusEntry
}

function submoduleEntry(area: GitStatusEntry['area'] = 'unstaged'): GitStatusEntry {
  return {
    path: 'sub',
    status: 'modified',
    area,
    submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
  } as GitStatusEntry
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
  mocks.getRuntimeGitSubmoduleStatus.mockReset()
  latest = null
})

describe('useSourceControlSubmoduleStatus', () => {
  it('drops a late response from a previous worktree when the active worktree changed', async () => {
    const a = deferred<{ entries: GitStatusEntry[] }>()
    const b = deferred<{ entries: GitStatusEntry[] }>()
    mocks.getRuntimeGitSubmoduleStatus.mockImplementation((ctx: { worktreeId?: string | null }) =>
      ctx.worktreeId === 'A' ? a.promise : b.promise
    )

    const container = document.createElement('div')
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<Probe worktreeId="A" worktreePath="/a" entries={[submoduleEntry()]} />)
    })
    // Expand a submodule in worktree A -> issues the (slow) A request.
    await act(async () => {
      latest?.toggleSubmodule(submoduleEntry())
    })
    await flush()

    // Switch to worktree B (same submodule path) and expand it there.
    await act(async () => {
      root.render(<Probe worktreeId="B" worktreePath="/b" entries={[submoduleEntry()]} />)
    })
    await act(async () => {
      latest?.toggleSubmodule(submoduleEntry())
    })
    await flush()

    // B resolves first, then the stale A response arrives late.
    await act(async () => {
      b.resolve({ entries: [innerEntry('from-b.ts')] })
    })
    await flush()
    await act(async () => {
      a.resolve({ entries: [innerEntry('from-a.ts')] })
    })
    await flush()

    expect(latest?.submoduleStatusByKey['unstaged::sub']).toEqual({
      status: 'loaded',
      entries: [innerEntry('from-b.ts')]
    })
  })

  it('does not let a late error from a previous worktree overwrite the current status', async () => {
    const a = deferred<{ entries: GitStatusEntry[] }>()
    const b = deferred<{ entries: GitStatusEntry[] }>()
    mocks.getRuntimeGitSubmoduleStatus.mockImplementation((ctx: { worktreeId?: string | null }) =>
      ctx.worktreeId === 'A' ? a.promise : b.promise
    )

    const container = document.createElement('div')
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<Probe worktreeId="A" worktreePath="/a" entries={[submoduleEntry()]} />)
    })
    await act(async () => {
      latest?.toggleSubmodule(submoduleEntry())
    })
    await flush()

    await act(async () => {
      root.render(<Probe worktreeId="B" worktreePath="/b" entries={[submoduleEntry()]} />)
    })
    await act(async () => {
      latest?.toggleSubmodule(submoduleEntry())
    })
    await flush()

    await act(async () => {
      b.resolve({ entries: [innerEntry('from-b.ts')] })
    })
    await flush()
    await act(async () => {
      a.reject(new Error('stale worktree failed'))
    })
    await flush()

    expect(latest?.submoduleStatusByKey['unstaged::sub']).toEqual({
      status: 'loaded',
      entries: [innerEntry('from-b.ts')]
    })
  })

  it('drops a late response from a previous runtime target on the same worktree', async () => {
    const envA = deferred<{ entries: GitStatusEntry[] }>()
    const envB = deferred<{ entries: GitStatusEntry[] }>()
    mocks.getRuntimeGitSubmoduleStatus.mockImplementation(
      (ctx: { settings?: { activeRuntimeEnvironmentId?: string | null } | null }) =>
        ctx.settings?.activeRuntimeEnvironmentId === 'env-b' ? envB.promise : envA.promise
    )

    const container = document.createElement('div')
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <Probe
          worktreeId="A"
          worktreePath="/a"
          settings={{ activeRuntimeEnvironmentId: 'env-a' }}
          entries={[submoduleEntry()]}
        />
      )
    })
    await act(async () => {
      latest?.toggleSubmodule(submoduleEntry())
    })
    await flush()

    await act(async () => {
      root.render(
        <Probe
          worktreeId="A"
          worktreePath="/a"
          settings={{ activeRuntimeEnvironmentId: 'env-b' }}
          entries={[submoduleEntry()]}
        />
      )
    })
    await act(async () => {
      latest?.toggleSubmodule(submoduleEntry())
    })
    await flush()

    await act(async () => {
      envB.resolve({ entries: [innerEntry('from-env-b.ts')] })
    })
    await flush()
    await act(async () => {
      envA.resolve({ entries: [innerEntry('from-env-a.ts')] })
    })
    await flush()

    expect(latest?.submoduleStatusByKey['unstaged::sub']).toEqual({
      status: 'loaded',
      entries: [innerEntry('from-env-b.ts')]
    })
  })

  it('passes the row area when expanding a staged submodule row', async () => {
    mocks.getRuntimeGitSubmoduleStatus.mockResolvedValue({
      entries: [innerEntry('from-index.ts')],
      didHitLimit: true
    })

    const container = document.createElement('div')
    const root = createRoot(container)
    roots.push(root)
    const stagedEntry = submoduleEntry('staged')

    await act(async () => {
      root.render(<Probe worktreeId="A" worktreePath="/a" entries={[stagedEntry]} />)
    })
    await act(async () => {
      latest?.toggleSubmodule(stagedEntry)
    })
    await flush()

    expect(mocks.getRuntimeGitSubmoduleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'A', worktreePath: '/a' }),
      'sub',
      'staged'
    )
    expect(latest?.submoduleStatusByKey['staged::sub']).toEqual({
      status: 'loaded',
      entries: [innerEntry('from-index.ts')],
      didHitLimit: true
    })
  })
})
