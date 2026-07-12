import { beforeEach, vi, type Mock } from 'vitest'
import { toast } from 'sonner'
import type { Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

// Shared harness for the repo-slice runtime-routing suite: sample repos, IPC/runtime
// mocks, and the window stub reset between tests. Extracted to keep the test file itself
// under the max-lines limit.

export const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

export const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2
}

export const sshRepo: Repo = {
  id: 'ssh-repo',
  path: '/home/orca/project',
  displayName: 'SSH',
  badgeColor: '#222',
  addedAt: 3,
  connectionId: 'ssh-1'
}

export const reposList: Mock = vi.fn()
export const reposAdd: Mock = vi.fn()
export const reposPickFolder: Mock = vi.fn()
export const reposClone: Mock = vi.fn()
export const reposCloneRemote: Mock = vi.fn()
export const reposRemove: Mock = vi.fn()
export const reposUpdate: Mock = vi.fn()
export const reposReorder: Mock = vi.fn()
export const projectsCreateHostSetup: Mock = vi.fn()
export const projectsSetupExistingFolder: Mock = vi.fn()
export const projectsUpdateHostSetup: Mock = vi.fn()
export const projectsDeleteHostSetup: Mock = vi.fn()
export const projectsUpdate: Mock = vi.fn()
export const projectGroupsMoveProject: Mock = vi.fn()
export const ptyKill: Mock = vi.fn()
export const runtimeEnvironmentCall: Mock = vi.fn()
export const runtimeEnvironmentTransportCall: Mock = vi.fn()
export const orcaProfileFindProjectProfiles: Mock = vi.fn()

// Registers the per-test reset + window stub. Call once inside the suite's module scope.
export function installReposRuntimeRoutingHarness(): void {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.mocked(toast.error).mockReset()
    vi.mocked(toast.info).mockReset()
    vi.mocked(toast.success).mockReset()
    vi.mocked(toast.warning).mockReset()
    reposList.mockReset()
    reposAdd.mockReset()
    reposPickFolder.mockReset()
    reposClone.mockReset()
    reposCloneRemote.mockReset()
    reposRemove.mockReset()
    reposUpdate.mockReset()
    reposReorder.mockReset()
    projectsCreateHostSetup.mockReset()
    projectsSetupExistingFolder.mockReset()
    projectsUpdateHostSetup.mockReset()
    projectsDeleteHostSetup.mockReset()
    projectsUpdate.mockReset()
    projectGroupsMoveProject.mockReset()
    ptyKill.mockReset()
    orcaProfileFindProjectProfiles.mockReset()
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentTransportCall.mockReset()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    vi.stubGlobal('window', {
      api: {
        repos: {
          list: reposList,
          add: reposAdd,
          clone: reposClone,
          cloneRemote: reposCloneRemote,
          pickFolder: reposPickFolder,
          remove: reposRemove,
          update: reposUpdate,
          reorder: reposReorder
        },
        projects: {
          update: projectsUpdate,
          createHostSetup: projectsCreateHostSetup,
          setupExistingFolder: projectsSetupExistingFolder,
          updateHostSetup: projectsUpdateHostSetup,
          deleteHostSetup: projectsDeleteHostSetup
        },
        projectGroups: {
          moveProject: projectGroupsMoveProject
        },
        orcaProfiles: {
          findProjectProfiles: orcaProfileFindProjectProfiles
        },
        pty: { kill: ptyKill },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
      }
    })
  })
}
