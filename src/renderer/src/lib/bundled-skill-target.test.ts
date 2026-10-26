import { describe, expect, it } from 'vitest'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  bundledSkillTargetKey,
  resolveBundledSkillTarget,
  servingExecutionHostId
} from './bundled-skill-target'

const WSL_PROJECT: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'p',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'p:wsl:Ubuntu'
  }
}

describe('resolveBundledSkillTarget', () => {
  it('plans nothing until the owning runtime is known', () => {
    expect(resolveBundledSkillTarget(null, undefined)).toBeNull()
  })

  it('sends a paired server or SSH host to that host, whatever the local project says', () => {
    const target = resolveBundledSkillTarget(
      { kind: 'environment', environmentId: 'env-1' },
      WSL_PROJECT
    )
    expect(target).toEqual({ kind: 'environment', environmentId: 'env-1' })
    expect(bundledSkillTargetKey(target!)).toBe('runtime:env-1')
  })

  it('plans nothing for a Windows project that runs in WSL', () => {
    const target = resolveBundledSkillTarget({ kind: 'local' }, WSL_PROJECT)
    expect(target).toBeNull()
  })

  it('plans nothing while a WSL project needs its distro repaired, never the Windows home', () => {
    expect(
      resolveBundledSkillTarget(
        { kind: 'local' },
        {
          status: 'repair-required',
          repair: {
            projectId: 'p',
            preferredRuntime: { kind: 'wsl', distro: 'Gone' },
            reason: 'wsl-distro-missing',
            source: 'project-override',
            cacheKey: 'p:repair'
          }
        }
      )
    ).toBeNull()
  })

  it('follows the active workspace to its paired host, and never plans this machine for direct SSH', () => {
    expect(resolveBundledSkillTarget({ kind: 'local' }, undefined, 'runtime:env-2')).toEqual({
      kind: 'environment',
      environmentId: 'env-2'
    })
    expect(resolveBundledSkillTarget({ kind: 'local' }, undefined, 'ssh:target-1')).toEqual({
      kind: 'ssh',
      targetId: 'target-1'
    })
  })

  it('plans nothing when an active workspace owner is unresolved after the catalog settles', () => {
    expect(resolveBundledSkillTarget({ kind: 'local' }, undefined, null)).toBeNull()
    expect(
      resolveBundledSkillTarget({ kind: 'environment', environmentId: 'focused' }, undefined, null)
    ).toBeNull()
  })

  it('keeps a proven local workspace target', () => {
    expect(resolveBundledSkillTarget({ kind: 'local' }, undefined, 'local')).toEqual({
      kind: 'local'
    })
  })

  it('plans this machine otherwise', () => {
    expect(resolveBundledSkillTarget({ kind: 'local' }, undefined)).toEqual({ kind: 'local' })
  })
})

describe('servingExecutionHostId', () => {
  const environments = [
    { id: 'paired', orcadDeployment: null },
    { id: 'box-server', orcadDeployment: { sshTargetId: 'box' } },
    { id: 'wsl-server', orcadDeployment: { kind: 'wsl' as const } }
  ]

  it('sends an SSH workspace to the managed server that serves its host', () => {
    const hostId = servingExecutionHostId('ssh:box', environments)
    expect(hostId).toBe('runtime:box-server')
    expect(resolveBundledSkillTarget({ kind: 'local' }, undefined, hostId)).toEqual({
      kind: 'environment',
      environmentId: 'box-server'
    })
  })

  it('keeps an SSH host no server serves as SSH, which never plans this machine', () => {
    const hostId = servingExecutionHostId('ssh:other', environments)
    expect(hostId).toBe('ssh:other')
    const target = resolveBundledSkillTarget({ kind: 'local' }, undefined, hostId)
    expect(target).toEqual({ kind: 'ssh', targetId: 'other' })
    expect(bundledSkillTargetKey(target!)).toBe('ssh:other')
  })

  it('leaves local and paired owners alone', () => {
    expect(servingExecutionHostId('local', environments)).toBe('local')
    expect(servingExecutionHostId('runtime:paired', environments)).toBe('runtime:paired')
    expect(servingExecutionHostId(null, environments)).toBeNull()
  })
})
