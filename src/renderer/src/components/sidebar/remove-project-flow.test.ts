import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  state: {
    settings: { skipRemoveProjectConfirm: false, activeRuntimeEnvironmentId: 'local' },
    repos: [] as Repo[],
    removeProject: vi.fn().mockResolvedValue(undefined),
    openModal: vi.fn()
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))

import { runProjectRemoval } from './remove-project-flow'

const localRepo: Repo = {
  id: 'project',
  path: '/project',
  displayName: 'Project',
  kind: 'git',
  badgeColor: '#737373',
  addedAt: 1,
  executionHostId: 'local'
}
const target = { repoId: 'project', displayName: 'Project', hostId: 'local' as const }

describe('runProjectRemoval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.settings.skipRemoveProjectConfirm = false
    mocks.state.repos = [localRepo]
  })

  it('asks by default', () => {
    runProjectRemoval(target)
    expect(mocks.state.openModal).toHaveBeenCalledWith('confirm-remove-folder', target)
    expect(mocks.state.removeProject).not.toHaveBeenCalled()
  })

  it.each(['git', 'folder'] as const)('skips the dialog for an opted-in %s project', (kind) => {
    mocks.state.settings.skipRemoveProjectConfirm = true
    mocks.state.repos = [{ ...localRepo, kind }]
    runProjectRemoval(target)
    expect(mocks.state.removeProject).toHaveBeenCalledWith('project', {
      hostId: 'local',
      errorFeedback: 'toast'
    })
    expect(mocks.state.openModal).not.toHaveBeenCalled()
  })

  it('preserves the selected SSH host when project ids overlap', () => {
    mocks.state.settings.skipRemoveProjectConfirm = true
    mocks.state.repos.push({ ...localRepo, executionHostId: 'ssh:remote', connectionId: 'remote' })
    runProjectRemoval({ ...target, hostId: 'ssh:remote' })
    expect(mocks.state.removeProject).toHaveBeenCalledWith('project', {
      hostId: 'ssh:remote',
      errorFeedback: 'toast'
    })
  })

  it('keeps the warning for VM projects even after opting out', () => {
    mocks.state.settings.skipRemoveProjectConfirm = true
    mocks.state.repos = [
      { ...localRepo, connectionId: 'runtime-ssh-vm', executionHostId: 'ssh:runtime-ssh-vm' }
    ]
    const vmTarget = { ...target, hostId: 'ssh:runtime-ssh-vm' as const }
    runProjectRemoval(vmTarget)
    expect(mocks.state.openModal).toHaveBeenCalledWith('confirm-remove-folder', vmTarget)
    expect(mocks.state.removeProject).not.toHaveBeenCalled()
  })

  it('does not skip for an unresolved host', () => {
    mocks.state.settings.skipRemoveProjectConfirm = true
    runProjectRemoval({ ...target, hostId: 'ssh:missing' })
    expect(mocks.state.removeProject).not.toHaveBeenCalled()
    expect(mocks.state.openModal).toHaveBeenCalled()
  })

  it('asks again after the preference is re-enabled', () => {
    mocks.state.settings.skipRemoveProjectConfirm = true
    runProjectRemoval(target)
    mocks.state.settings.skipRemoveProjectConfirm = false
    runProjectRemoval(target)
    expect(mocks.state.removeProject).toHaveBeenCalledTimes(1)
    expect(mocks.state.openModal).toHaveBeenCalledTimes(1)
  })
})
