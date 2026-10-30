import { expect, it } from 'vitest'
import {
  resolveWorktreeOperationRouteResultForHost,
  type WorktreeOperationRouteState
} from './worktree-operation-route'

const id = 'project::/workspace'
const owner = {
  id,
  repoId: 'project',
  hostId: 'ssh:builder' as const,
  runtimeOwnerEnvironmentId: 'server'
}
const rival = { ...owner, runtimeOwnerEnvironmentId: 'other' }
const resolve = (state: WorktreeOperationRouteState) =>
  resolveWorktreeOperationRouteResultForHost(state, id, 'ssh:builder')
const resolved = (runtimeEnvironmentId: string | null) => ({
  kind: 'resolved',
  route: { executionHostId: 'ssh:builder', runtimeEnvironmentId }
})

it.each(['tracked', 'detected'] as const)(
  'invalidates SSH ownership evidence when a %s rival appears and disappears',
  (catalog) => {
    const state: WorktreeOperationRouteState = { worktreesByRepo: { project: [owner] } }
    expect(resolve(state)).toEqual(resolved('server'))
    const contested = {
      ...state,
      ...(catalog === 'tracked'
        ? { worktreesByRepo: { project: [owner], other: [rival] } }
        : { detectedWorktreesByRepo: { other: { worktrees: [rival] } } })
    }
    expect(resolve(contested)).toEqual({ kind: 'ambiguous' })
    expect(resolve(contested)).toEqual({ kind: 'ambiguous' })
    expect(
      resolve({ ...contested, worktreesByRepo: { project: [owner] }, detectedWorktreesByRepo: {} })
    ).toEqual(resolved('server'))
    expect(resolve({ ...state, worktreesByRepo: {} })).toEqual(resolved(null))
    expect(resolve(state)).toEqual(resolved('server'))
  }
)

it('invalidates legacy SSH transport evidence with the repository snapshot', () => {
  const repo = {
    id: 'project',
    connectionId: 'builder',
    executionHostId: 'runtime:server' as const
  }
  const state: WorktreeOperationRouteState = {
    worktreesByRepo: { project: [{ ...owner, runtimeOwnerEnvironmentId: undefined }] },
    repos: [repo]
  }
  expect(resolve(state)).toEqual(resolved('server'))
  const otherRepo = { ...repo, executionHostId: 'runtime:other' as const }
  expect(resolve({ ...state, repos: [otherRepo] })).toEqual(resolved('other'))
  expect(resolve({ ...state, repos: [repo, otherRepo] })).toEqual({ kind: 'ambiguous' })
  expect(resolve({ ...state, repos: [] })).toEqual(resolved(null))
  expect(resolve(state)).toEqual(resolved('server'))
})
