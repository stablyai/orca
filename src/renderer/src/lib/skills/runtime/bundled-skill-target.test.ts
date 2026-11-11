import { describe, expect, it } from 'vitest'
import { resolveBundledSkillTarget } from './bundled-skill-target'

describe('resolveBundledSkillTarget', () => {
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
})
