// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { Worktree } from '../../../../shared/worktree/types'

import { useOwnedDiffCommentTarget } from './use-diff-comment-owner'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: vi.fn().mockResolvedValue({ ok: true })
}))

const REPO = 'repo-1'
const WT = `${REPO}::/work/a`
const OTHER = `${REPO}::/work/b`
const initialState = useAppStore.getState()
const SSH_BOX = { kind: 'worktree', authority: { endpoint: { kind: 'self' }, at: 'ssh:box' } }

function row(
  id: string,
  hostId: ExecutionHostId,
  diffComments: DiffComment[] = [],
  runtimeOwnerEnvironmentId?: string
): Worktree {
  return makeWorktree({
    id,
    repoId: REPO,
    path: id.slice(REPO.length + 2),
    hostId,
    diffComments,
    ...(runtimeOwnerEnvironmentId ? { runtimeOwnerEnvironmentId } : {})
  })
}

function note(id: string, filePath = 'a.ts'): DiffComment {
  return { id, worktreeId: WT, filePath, lineNumber: 1, body: id, createdAt: 1, side: 'modified' }
}

// Same worktree on this computer and on an SSH host, plus an unrelated worktree.
function seedTwins(selected: ExecutionHostId, local = [note('l1'), note('l2')]) {
  useAppStore.setState({
    activeWorktreeId: WT,
    activeWorkspaceExecutionHostId: selected,
    worktreesByRepo: {
      [REPO]: [row(WT, 'local', local), row(WT, 'ssh:box', [note('s1')]), row(OTHER, 'local')]
    }
  })
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  vi.mocked(callRuntimeRpc).mockClear()
})

afterEach(() => {
  cleanup()
})

describe('note owner views', () => {
  it('keep the composer opener installed before rows load, capturing the copy it opens on', () => {
    useAppStore.setState({
      activeWorktreeId: WT,
      activeWorkspaceExecutionHostId: 'ssh:box',
      worktreesByRepo: { [REPO]: [] }
    })
    const { result } = renderHook(() =>
      useOwnedDiffCommentTarget<{ line: number }>(WT, 'selection')
    )
    const installedOpener = result.current[1]
    seedTwins('ssh:box')

    act(() => installedOpener({ line: 1 }))
    expect(result.current[2].current).toMatchObject(SSH_BOX)

    act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))
    act(() => installedOpener((target) => target && { line: target.line + 1 }))
    expect(result.current[1]).toBe(installedOpener)
    expect(result.current[2].current).toMatchObject(SSH_BOX)
  })
})

describe('retained sources', () => {
  it('capture through an installed opener the source the surface shows now', () => {
    useAppStore.setState({
      worktreesByRepo: {
        [REPO]: [row(WT, 'runtime:a', [], 'a'), row(WT, 'runtime:b', [], 'b')]
      }
    })
    const { result, rerender } = renderHook(
      ({ runtimeEnvironmentId }) =>
        useOwnedDiffCommentTarget<{ line: number }>(WT, { runtimeEnvironmentId }),
      { initialProps: { runtimeEnvironmentId: 'a' } }
    )
    const installedOpener = result.current[1]
    rerender({ runtimeEnvironmentId: 'b' })

    act(() => installedOpener({ line: 1 }))
    expect(result.current[2].current).toMatchObject({
      authority: { endpoint: { kind: 'environment', environmentId: 'b' } }
    })
  })
})
