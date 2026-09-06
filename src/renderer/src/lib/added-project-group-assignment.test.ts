import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../shared/execution-host'
import {
  addProjectTargetForGroup,
  assignAddedProjectToTargetGroup,
  readAddProjectTarget,
  type AddedProjectGroupAssignmentState
} from './added-project-group-assignment'

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: `/tmp/${overrides.id}`,
    displayName: overrides.id,
    projectGroupId: null,
    connectionId: null,
    executionHostId: null,
    ...overrides
  } as Repo
}

function makeGroup(overrides: Partial<ProjectGroup> & { id: string; name: string }): ProjectGroup {
  return {
    parentPath: null,
    connectionId: null,
    executionHostId: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

const LOCAL_GROUP = makeGroup({ id: 'group-1', name: 'OSS' })

function makeState(
  overrides: Partial<AddedProjectGroupAssignmentState> = {}
): AddedProjectGroupAssignmentState {
  return {
    addProjectTarget: { groupId: 'group-1', hostId: LOCAL_EXECUTION_HOST_ID },
    projectGroups: [LOCAL_GROUP],
    moveProjectToGroup: vi.fn().mockResolvedValue(true),
    clearAddProjectTarget: vi.fn(),
    ...overrides
  }
}

beforeEach(() => {
  mocks.toastError.mockReset()
})

describe('addProjectTargetForGroup', () => {
  it('names the local host for a group without a host stamp', () => {
    expect(addProjectTargetForGroup(LOCAL_GROUP)).toEqual({
      groupId: 'group-1',
      hostId: LOCAL_EXECUTION_HOST_ID
    })
  })

  // Why: the store keys groups on [host, id], so the target must carry the owner host too.
  it('derives the SSH host from the connection id', () => {
    const group = makeGroup({ id: 'group-1', name: 'OSS', connectionId: 'ssh-1' })

    expect(addProjectTargetForGroup(group)).toEqual({
      groupId: 'group-1',
      hostId: toSshExecutionHostId('ssh-1')
    })
  })

  it('prefers the stamped execution host over the connection id', () => {
    const group = makeGroup({
      id: 'group-1',
      name: 'OSS',
      connectionId: 'ssh-1',
      executionHostId: 'runtime:env-1'
    })

    expect(addProjectTargetForGroup(group)).toEqual({ groupId: 'group-1', hostId: 'runtime:env-1' })
  })
})

describe('readAddProjectTarget', () => {
  it('reads a well-formed target out of modal data', () => {
    expect(
      readAddProjectTarget({ addProjectTarget: { groupId: 'group-1', hostId: 'local' } })
    ).toEqual({ groupId: 'group-1', hostId: 'local' })
  })

  it.each([
    ['no target', {}],
    ['a non-object target', { addProjectTarget: 'group-1' }],
    ['a missing host', { addProjectTarget: { groupId: 'group-1' } }],
    ['a missing group', { addProjectTarget: { hostId: 'local' } }],
    ['an empty group id', { addProjectTarget: { groupId: '', hostId: 'local' } }]
  ])('returns null for %s', (_label, data) => {
    expect(readAddProjectTarget(data)).toBeNull()
  })

  // Why: both sides of the later host comparison normalize, so the target must too or a padded
  // id would misreport the group as gone.
  it('normalizes a padded host id', () => {
    expect(
      readAddProjectTarget({ addProjectTarget: { groupId: 'group-1', hostId: ' local ' } })
    ).toEqual({ groupId: 'group-1', hostId: LOCAL_EXECUTION_HOST_ID })
  })

  it('rejects a host id that is not an execution host', () => {
    expect(
      readAddProjectTarget({ addProjectTarget: { groupId: 'group-1', hostId: 'nope' } })
    ).toBeNull()
  })
})

describe('assignAddedProjectToTargetGroup', () => {
  it('moves the added project into the target group', async () => {
    const state = makeState()

    await assignAddedProjectToTargetGroup(state, makeRepo({ id: 'repo-1' }))

    expect(state.moveProjectToGroup).toHaveBeenCalledWith('repo-1', 'group-1')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('does nothing when the add flow has no target', async () => {
    const state = makeState({ addProjectTarget: null })

    await assignAddedProjectToTargetGroup(state, makeRepo({ id: 'repo-1' }))

    expect(state.moveProjectToGroup).not.toHaveBeenCalled()
    expect(state.clearAddProjectTarget).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  // Why: re-adding an existing project must keep the group it already has.
  it('leaves an already grouped project where it is', async () => {
    const state = makeState()

    await assignAddedProjectToTargetGroup(
      state,
      makeRepo({ id: 'repo-1', projectGroupId: 'group-other' })
    )

    expect(state.moveProjectToGroup).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  // Why: skipping the move must still burn the target, or it stays armed for the next add.
  it.each([
    ['the project is already grouped', { id: 'repo-1', projectGroupId: 'group-other' }],
    ['the target group is gone', { id: 'repo-1' }],
    ['the hosts do not match', { id: 'repo-1', connectionId: 'ssh-1' }]
  ])('consumes the target even when %s', async (label, repoOverrides) => {
    const state = makeState(label === 'the target group is gone' ? { projectGroups: [] } : {})

    await assignAddedProjectToTargetGroup(state, makeRepo(repoOverrides))

    expect(state.clearAddProjectTarget).toHaveBeenCalledTimes(1)
  })

  // Why: without this, a later unrelated add would inherit the group.
  it('consumes the target so it applies to one project only', async () => {
    const state = makeState()

    await assignAddedProjectToTargetGroup(state, makeRepo({ id: 'repo-1' }))

    expect(state.clearAddProjectTarget).toHaveBeenCalledTimes(1)
  })

  it('reports a target group that disappeared mid-flow', async () => {
    const state = makeState({ projectGroups: [] })

    await assignAddedProjectToTargetGroup(state, makeRepo({ id: 'repo-1' }))

    expect(state.moveProjectToGroup).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  // Why: the store keys groups on [host, id], so a same-id group on another host is not the target.
  it('does not match a same-id group belonging to another host', async () => {
    const state = makeState({
      projectGroups: [makeGroup({ id: 'group-1', name: 'OSS', connectionId: 'ssh-1' })]
    })

    await assignAddedProjectToTargetGroup(state, makeRepo({ id: 'repo-1' }))

    expect(state.moveProjectToGroup).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  // Why: the backend normalizes an unknown group to null and still reports success, so a
  // cross-host move would silently leave the project ungrouped.
  it('refuses to move a project onto a group from a different host', async () => {
    const state = makeState()

    await assignAddedProjectToTargetGroup(
      state,
      makeRepo({ id: 'repo-1', connectionId: 'ssh-1', displayName: 'orca' })
    )

    expect(state.moveProjectToGroup).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    const [message, options] = mocks.toastError.mock.calls[0]
    expect(String(message)).toContain('OSS')
    expect(String(options?.description)).toContain('orca')
  })

  it('reports a rejected move instead of leaving the project silently ungrouped', async () => {
    const state = makeState({ moveProjectToGroup: vi.fn().mockResolvedValue(false) })

    await assignAddedProjectToTargetGroup(state, makeRepo({ id: 'repo-1', displayName: 'orca' }))

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    const [message, options] = mocks.toastError.mock.calls[0]
    expect(String(message)).toContain('OSS')
    expect(String(options?.description)).toContain('orca')
  })

  // Why: callers discard the promise, so a throw here would land in an unhandled rejection.
  it('never rejects when the move throws', async () => {
    const state = makeState({
      moveProjectToGroup: vi.fn().mockRejectedValue(new Error('host offline'))
    })

    await expect(
      assignAddedProjectToTargetGroup(state, makeRepo({ id: 'repo-1' }))
    ).resolves.toBeUndefined()
  })

  it('never rejects when the store shape is unexpected', async () => {
    const state = makeState({
      projectGroups: undefined as unknown as readonly ProjectGroup[]
    })

    await expect(
      assignAddedProjectToTargetGroup(state, makeRepo({ id: 'repo-1' }))
    ).resolves.toBeUndefined()
  })
})

describe('assignAddedProjectToTargetGroup with an explicit target', () => {
  // Why: the non-git confirm dialog closes (dropping the store target) before its add resolves,
  // so it hands the target down the call instead.
  it('honors an explicit target after the store target is gone', async () => {
    const state = makeState({ addProjectTarget: null })

    await assignAddedProjectToTargetGroup(state, makeRepo({ id: 'repo-1' }), {
      groupId: 'group-1',
      hostId: LOCAL_EXECUTION_HOST_ID
    })

    expect(state.moveProjectToGroup).toHaveBeenCalledWith('repo-1', 'group-1')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('prefers the explicit target over a store target', async () => {
    const state = makeState({
      projectGroups: [LOCAL_GROUP, makeGroup({ id: 'group-2', name: 'Other' })]
    })

    await assignAddedProjectToTargetGroup(state, makeRepo({ id: 'repo-1' }), {
      groupId: 'group-2',
      hostId: LOCAL_EXECUTION_HOST_ID
    })

    expect(state.moveProjectToGroup).toHaveBeenCalledWith('repo-1', 'group-2')
  })
})

describe('assignAddedProjectToTargetGroup unexpected failures', () => {
  // Why: never rejecting must not mean never telling the user.
  it('reports an unexpected failure instead of only logging it', async () => {
    const state = makeState({
      projectGroups: undefined as unknown as readonly ProjectGroup[]
    })

    await assignAddedProjectToTargetGroup(state, makeRepo({ id: 'repo-1', displayName: 'orca' }))

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    const [, options] = mocks.toastError.mock.calls[0]
    expect(String(options?.description)).toContain('orca')
  })
})
