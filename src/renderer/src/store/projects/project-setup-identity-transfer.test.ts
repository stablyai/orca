import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  negotiateProjectSetupIdentity,
  redactProjectGitRemoteIdentityForTransfer
} from './project-setup-identity-transfer'

const supportsCapability = vi.hoisted(() => vi.fn())

vi.mock('../../runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: supportsCapability
}))

describe('redactProjectGitRemoteIdentityForTransfer', () => {
  it('strips embedded credentials from both remote urls', () => {
    expect(
      redactProjectGitRemoteIdentityForTransfer({
        canonicalKey: 'github.com/TemplateHQ/site-template',
        remoteName: 'upstream',
        remoteUrl: 'https://user:token@github.com/TemplateHQ/site-template.git',
        origin: {
          canonicalKey: 'github.com/alice/site',
          remoteUrl: 'https://token:@github.com/alice/site.git'
        }
      })
    ).toEqual({
      canonicalKey: 'github.com/TemplateHQ/site-template',
      remoteName: 'upstream',
      remoteUrl: 'https://github.com/TemplateHQ/site-template.git',
      origin: {
        canonicalKey: 'github.com/alice/site',
        remoteUrl: 'https://github.com/alice/site.git'
      }
    })
  })

  it('keeps a plain identity unchanged', () => {
    const identity = {
      canonicalKey: 'github.com/alice/site',
      remoteName: 'origin',
      remoteUrl: 'git@github.com:alice/site.git'
    }
    expect(redactProjectGitRemoteIdentityForTransfer(identity)).toEqual(identity)
  })

  it('drops a row missing a part the receiver requires instead of sending a blank', () => {
    expect(
      redactProjectGitRemoteIdentityForTransfer({
        canonicalKey: 'github.com/alice/site',
        remoteName: 'origin',
        remoteUrl: ''
      })
    ).toBeUndefined()
    expect(redactProjectGitRemoteIdentityForTransfer(undefined)).toBeUndefined()
  })

  it('drops an incomplete origin but keeps the identity', () => {
    expect(
      redactProjectGitRemoteIdentityForTransfer({
        canonicalKey: 'github.com/TemplateHQ/site-template',
        remoteName: 'upstream',
        remoteUrl: 'https://github.com/TemplateHQ/site-template.git',
        origin: { canonicalKey: 'github.com/alice/site', remoteUrl: '' }
      })
    ).toEqual({
      canonicalKey: 'github.com/TemplateHQ/site-template',
      remoteName: 'upstream',
      remoteUrl: 'https://github.com/TemplateHQ/site-template.git'
    })
  })
})

describe('negotiateProjectSetupIdentity', () => {
  const templateProject = {
    projectId: 'github:alice/site',
    providerIdentity: { provider: 'github' as const, owner: 'TemplateHQ', repo: 'site-template' },
    gitRemoteIdentity: {
      canonicalKey: 'github.com/TemplateHQ/site-template',
      remoteName: 'upstream',
      remoteUrl: 'https://github.com/TemplateHQ/site-template.git',
      origin: {
        canonicalKey: 'github.com/alice/site',
        remoteUrl: 'https://github.com/alice/site.git'
      }
    }
  }

  beforeEach(() => {
    supportsCapability.mockReset()
  })

  it('carries the checkout identity to the local host', async () => {
    await expect(
      negotiateProjectSetupIdentity({ target: { kind: 'local' }, ...templateProject })
    ).resolves.toMatchObject({
      projectId: 'github:alice/site',
      projectGitRemoteIdentity: { origin: { canonicalKey: 'github.com/alice/site' } }
    })
    expect(supportsCapability).not.toHaveBeenCalled()
  })

  it('carries it to a runtime host that understands checkout-keyed ids', async () => {
    supportsCapability.mockResolvedValue(true)

    await expect(
      negotiateProjectSetupIdentity({
        target: { kind: 'environment', environmentId: 'gpu-vm' },
        ...templateProject
      })
    ).resolves.toMatchObject({
      projectId: 'github:alice/site',
      projectGitRemoteIdentity: { canonicalKey: 'github.com/TemplateHQ/site-template' }
    })
  })

  it('refuses an older runtime host instead of adding it to the ancestor project', async () => {
    supportsCapability.mockResolvedValue(false)

    await expect(
      negotiateProjectSetupIdentity({
        target: { kind: 'environment', environmentId: 'gpu-vm' },
        ...templateProject
      })
    ).rejects.toThrow(/too old to set this project up/)
  })

  it('does not refuse an older host for a plain non-GitHub repo, whose id did not change', async () => {
    supportsCapability.mockResolvedValue(false)

    await expect(
      negotiateProjectSetupIdentity({
        target: { kind: 'environment', environmentId: 'gpu-vm' },
        projectId: 'git:gitlab.com/alice/app',
        providerIdentity: undefined,
        gitRemoteIdentity: {
          canonicalKey: 'gitlab.com/alice/app',
          remoteName: 'origin',
          remoteUrl: 'git@gitlab.com:alice/app.git'
        }
      })
    ).resolves.toMatchObject({ projectId: 'git:gitlab.com/alice/app' })
    expect(supportsCapability).not.toHaveBeenCalled()
  })

  it('does not refuse an older host for a folder project, which keys by repo id on both sides', async () => {
    supportsCapability.mockResolvedValue(false)

    await expect(
      negotiateProjectSetupIdentity({
        target: { kind: 'environment', environmentId: 'gpu-vm' },
        projectId: 'repo:folder-1',
        providerIdentity: undefined,
        gitRemoteIdentity: undefined
      })
    ).resolves.toEqual({ projectId: 'repo:folder-1' })
    expect(supportsCapability).not.toHaveBeenCalled()
  })

  it('refuses an older host for a non-GitHub fork, whose old id named the upstream remote', async () => {
    supportsCapability.mockResolvedValue(false)

    await expect(
      negotiateProjectSetupIdentity({
        target: { kind: 'environment', environmentId: 'gpu-vm' },
        projectId: 'git:gitlab.com/alice/app',
        providerIdentity: undefined,
        gitRemoteIdentity: {
          canonicalKey: 'gitlab.com/team/app',
          remoteName: 'upstream',
          remoteUrl: 'git@gitlab.com:team/app.git',
          origin: {
            canonicalKey: 'gitlab.com/alice/app',
            remoteUrl: 'git@gitlab.com:alice/app.git'
          }
        }
      })
    ).rejects.toThrow(/too old to set this project up/)
  })

  it('does not consult the capability when the checkout and ancestor ids agree', async () => {
    await expect(
      negotiateProjectSetupIdentity({
        target: { kind: 'environment', environmentId: 'gpu-vm' },
        projectId: 'github:alice/app',
        providerIdentity: { provider: 'github', owner: 'alice', repo: 'app' },
        gitRemoteIdentity: undefined
      })
    ).resolves.toMatchObject({ projectId: 'github:alice/app' })
    expect(supportsCapability).not.toHaveBeenCalled()
  })
})
