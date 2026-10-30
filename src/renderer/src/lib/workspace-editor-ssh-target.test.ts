import { describe, expect, it } from 'vitest'
import { getWorkspaceEditorSshHost } from './workspace-editor-ssh-target'

const link = { sshTargetId: 'ssh-1', sshTargetGeneration: 1, localPort: 41000, remotePort: 6768 }
const WORKTREE_ID = 'repo-1::/home/ada/project'

function stateWith(
  environment: Record<string, unknown>,
  worktreeHostId: 'runtime:env-1' | 'ssh:box' = 'runtime:env-1'
): Parameters<typeof getWorkspaceEditorSshHost>[0] {
  return {
    runtimeEnvironments: [{ id: 'env-1', ...environment }],
    runtimeEnvironmentCatalogHydrated: true,
    repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:env-1' }],
    worktreesByRepo: {
      'repo-1': [
        {
          id: WORKTREE_ID,
          repoId: 'repo-1',
          hostId: worktreeHostId,
          runtimeOwnerEnvironmentId: 'env-1'
        }
      ]
    }
  }
}

describe('getWorkspaceEditorSshHost', () => {
  it('names the SSH host a managed server runs on for a workspace on that machine', () => {
    expect(
      getWorkspaceEditorSshHost(stateWith({ orcadDeployment: link }), {
        workspaceId: WORKTREE_ID,
        hostId: 'runtime:env-1'
      })
    ).toEqual({ environmentId: 'env-1', sshTargetId: 'ssh-1' })
  })

  it('names the SSH host of a paired server reached over SSH access', () => {
    const sshAccess = { ...link, endpointId: 'tunnel', previousPreferredEndpointId: 'lan' }
    expect(
      getWorkspaceEditorSshHost(stateWith({ sshAccess }), { workspaceId: WORKTREE_ID })
    ).toEqual({ environmentId: 'env-1', sshTargetId: 'ssh-1' })
  })

  it('refuses a workspace the server reaches through its own SSH host', () => {
    expect(
      getWorkspaceEditorSshHost(stateWith({ orcadDeployment: link }, 'ssh:box'), {
        workspaceId: WORKTREE_ID,
        hostId: 'ssh:box'
      })
    ).toBeNull()
  })

  it('places a folder workspace by its own SSH connection, not only its server stamp', () => {
    const folderState = (
      connectionId: string | null
    ): Parameters<typeof getWorkspaceEditorSshHost>[0] => ({
      runtimeEnvironments: [{ id: 'env-1', orcadDeployment: link }],
      runtimeEnvironmentCatalogHydrated: true,
      folderWorkspaces: [
        { id: 'fw-1', projectGroupId: 'g-1', connectionId, executionHostId: 'runtime:env-1' }
      ],
      projectGroups: [{ id: 'g-1', executionHostId: 'runtime:env-1' }]
    })
    const ref = { workspaceId: 'folder:fw-1', hostId: 'runtime:env-1' as const }
    expect(getWorkspaceEditorSshHost(folderState(null), ref)).toEqual({
      environmentId: 'env-1',
      sshTargetId: 'ssh-1'
    })
    expect(getWorkspaceEditorSshHost(folderState('nested'), ref)).toBeNull()
  })

  it.each([
    ['a network-paired server', {}],
    ['an ephemeral VM', { orcadDeployment: { ...link, sshTargetId: 'runtime-ssh-vm-1' } }]
  ])('refuses %s', (_label, environment) => {
    expect(
      getWorkspaceEditorSshHost(stateWith(environment), { workspaceId: WORKTREE_ID })
    ).toBeNull()
  })

  it('refuses a local or missing workspace', () => {
    expect(getWorkspaceEditorSshHost({}, { workspaceId: 'local-repo::/tmp/x' })).toBeNull()
    expect(getWorkspaceEditorSshHost(stateWith({ orcadDeployment: link }), null)).toBeNull()
  })
})
