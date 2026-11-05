// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GitStatusEntry,
  GitStatusResult
} from '../../../../../../shared/git/status/git-status-types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  refreshGitStatusForWorktree,
  refreshGitStatusForWorktreeStrict
} from '../sync/git-status-refresh'
import {
  useSourceControlSubmoduleStatus,
  type UseSourceControlSubmoduleStatusResult
} from './use-submodule-status'

const mocks: {
  childStatus: ReturnType<typeof vi.fn>
  hostId: ExecutionHostId
  connectionId: string | undefined
} = vi.hoisted(() => ({
  childStatus: vi.fn(),
  hostId: 'local',
  connectionId: undefined
}))
vi.mock('@/lib/worktree-git-copy', () => ({
  useWorktreeGitCopyHostId: () => mocks.hostId,
  resolveWorktreeGitCopyNow: (worktreeId: string) => ({
    worktreeId,
    hostId: mocks.hostId,
    connectionId: mocks.connectionId,
    transport: { kind: 'local' }
  })
}))
vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitSubmoduleStatus: mocks.childStatus,
  getRuntimeGitStatus: async () => ({
    entries: acceptedEntries,
    conflictOperation: 'unknown',
    upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
  })
}))

const target: RuntimeClientTarget = { kind: 'local' }
const parentEntries: GitStatusEntry[] = [
  {
    path: 'vendor/lib',
    status: 'modified',
    area: 'unstaged',
    submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false }
  }
]
let acceptedEntries = parentEntries
let renderedEntries = parentEntries
const firstChild: GitStatusResult = {
  conflictOperation: 'unknown',
  entries: [{ path: 'first.ts', status: 'modified', area: 'unstaged' }]
}
const secondChild: GitStatusResult = {
  conflictOperation: 'unknown',
  entries: [{ path: 'second.ts', status: 'untracked', area: 'untracked' }]
}
const key = 'unstaged::vendor/lib'
let latest: UseSourceControlSubmoduleStatusResult
let root: Root
let container: HTMLDivElement
let worktreeId: string

function Probe(): null {
  latest = useSourceControlSubmoduleStatus({
    activeWorktreeId: worktreeId,
    worktreePath: '/repo',
    activeRepoTarget: target,
    entries: renderedEntries
  })
  return null
}
async function render(id = 'repo::/repo'): Promise<void> {
  worktreeId = id
  await act(async () => {
    root.render(createElement(Probe))
  })
}
async function expand(): Promise<void> {
  await act(async () => {
    latest.toggleSubmodule(parentEntries[0])
  })
}
async function refresh(strict = false): Promise<void> {
  const args = {
    target,
    ownerHostId: mocks.hostId,
    worktreeId,
    worktreePath: '/repo',
    connectionId: mocks.connectionId,
    deps: {
      setGitStatus: () => {},
      updateWorktreeGitIdentity: () => {},
      setUpstreamStatus: () => {},
      fetchUpstreamStatus: async () => null
    }
  }
  await act(async () => {
    await (strict ? refreshGitStatusForWorktreeStrict(args) : refreshGitStatusForWorktree(args))
  })
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  acceptedEntries = parentEntries
  renderedEntries = parentEntries
  mocks.childStatus.mockReset().mockResolvedValue(firstChild)
  mocks.hostId = 'local'
  mocks.connectionId = undefined
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('expanded submodule status', () => {
  it('refreshes children after an accepted parent snapshot with identical root entries', async () => {
    await render()
    await expand()
    mocks.childStatus.mockResolvedValue(secondChild)
    await refresh()
    expect(latest.submoduleStatusByKey[key]).toEqual({
      status: 'loaded',
      entries: [{ path: 'second.ts', status: 'untracked', area: 'untracked' }]
    })
  })

  it('keeps a child read error when the same accepted parent snapshot is normalized in the store', async () => {
    await render()
    await expand()
    acceptedEntries = [
      ...parentEntries,
      {
        path: 'conflict.ts',
        status: 'modified',
        area: 'unstaged',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved'
      }
    ]
    mocks.childStatus.mockResolvedValue({
      entries: [],
      conflictOperation: 'unknown',
      readError: 'index unavailable'
    })
    await refresh()
    mocks.childStatus.mockResolvedValue(secondChild)
    renderedEntries = [
      ...parentEntries,
      {
        path: 'conflict.ts',
        status: 'modified',
        area: 'unstaged',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved',
        conflictStatusSource: 'git'
      }
    ]
    await render()
    expect(latest.submoduleStatusByKey[key]).toEqual({
      status: 'loaded',
      entries: [{ path: 'first.ts', status: 'modified', area: 'unstaged' }],
      error: 'index unavailable',
      refreshing: false
    })
  })

  it('keeps the newest refresh when another accepted snapshot arrives during a child read', async () => {
    await render()
    await expand()
    const oldRead = deferred<GitStatusResult>()
    mocks.childStatus.mockReturnValueOnce(oldRead.promise).mockResolvedValue(secondChild)
    await refresh()
    await refresh()
    await act(async () => {
      oldRead.resolve(firstChild)
    })
    expect(latest.submoduleStatusByKey[key]).toEqual({
      status: 'loaded',
      entries: [{ path: 'second.ts', status: 'untracked', area: 'untracked' }]
    })
  })

  it('keeps files on read failures and recovers through Retry', async () => {
    await render()
    await expand()
    mocks.childStatus.mockResolvedValue({
      entries: [],
      conflictOperation: 'unknown',
      readError: 'index unavailable'
    })
    await refresh()
    expect(latest.submoduleStatusByKey[key]).toEqual({
      status: 'loaded',
      entries: [{ path: 'first.ts', status: 'modified', area: 'unstaged' }],
      error: 'index unavailable',
      refreshing: false
    })
    mocks.childStatus.mockResolvedValue(secondChild)
    await act(async () => {
      latest.retrySubmodule(key)
    })
    expect(latest.submoduleStatusByKey[key]).toEqual({
      status: 'loaded',
      entries: [{ path: 'second.ts', status: 'untracked', area: 'untracked' }]
    })
  })

  it('keeps files when a refresh throws and clears the error after a successful read', async () => {
    await render()
    await expand()
    mocks.childStatus.mockRejectedValue(new Error('connection lost'))
    await refresh()
    expect(latest.submoduleStatusByKey[key]).toMatchObject({
      status: 'loaded',
      entries: [{ path: 'first.ts', status: 'modified', area: 'unstaged' }],
      error: 'connection lost'
    })
    mocks.childStatus.mockResolvedValue(secondChild)
    await refresh(true)
    expect(latest.submoduleStatusByKey[key]).toEqual({
      status: 'loaded',
      entries: [{ path: 'second.ts', status: 'untracked', area: 'untracked' }]
    })
  })

  it('does not replace new rows with an old result after switching A to B to A', async () => {
    const oldRead = deferred<GitStatusResult>()
    mocks.childStatus.mockReturnValueOnce(oldRead.promise)
    await render('A')
    await expand()
    await render('B')
    await render('A')
    mocks.childStatus.mockResolvedValue(secondChild)
    await expand()
    await act(async () => {
      oldRead.resolve(firstChild)
    })
    expect(latest.submoduleStatusByKey[key]).toEqual({
      status: 'loaded',
      entries: [{ path: 'second.ts', status: 'untracked', area: 'untracked' }]
    })
  })

  it('keeps same-id SSH twins isolated when their other copy refreshes', async () => {
    mocks.hostId = 'ssh:host-a'
    mocks.connectionId = 'host-a'
    await render()
    await expand()
    mocks.childStatus.mockResolvedValue(secondChild)
    mocks.hostId = 'ssh:host-b'
    mocks.connectionId = 'host-b'
    await refresh()
    expect(latest.submoduleStatusByKey[key]).toEqual({
      status: 'loaded',
      entries: [{ path: 'first.ts', status: 'modified', area: 'unstaged' }]
    })
  })
})
