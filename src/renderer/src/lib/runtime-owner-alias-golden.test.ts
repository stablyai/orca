import { describe, expect, it } from 'vitest'
import {
  getRuntimeEnvironmentIdForWorktree,
  resolveRuntimeOwnerForWorktree
} from './worktree-runtime-owner'
import { resolveOwner } from './resolve-owner'
import { OWNER_RESOLUTION_CASES } from './runtime-owner-alias-matrix.test-fixture'
import { LEGACY_RUNTIME_OWNER_GOLDEN } from './runtime-owner-alias-golden.test-fixture'

describe('the deprecated runtime-owner resolvers', () => {
  it('map every case exactly as on main before resolveOwner replaced them', () => {
    const actual = Object.fromEntries(
      OWNER_RESOLUTION_CASES.map((c) => {
        const owner = resolveRuntimeOwnerForWorktree(c.state, c.worktreeId)
        const environmentId = getRuntimeEnvironmentIdForWorktree(c.state, c.worktreeId)
        expect(environmentId, c.name).toBe(owner.kind === 'runtime' ? owner.environmentId : null)
        const value =
          owner.kind === 'runtime'
            ? owner.environmentId
            : owner.kind === 'ambiguous'
              ? 'ambiguous'
              : null
        return [c.name, value]
      })
    )
    expect(actual).toEqual(LEGACY_RUNTIME_OWNER_GOLDEN)
  })
})

describe('resolveOwner on the deprecated resolvers’ blind spots', () => {
  const byName = new Map(OWNER_RESOLUTION_CASES.map((c) => [c.name, c]))
  const ownerOf = (name: string) => {
    const c = byName.get(name)
    if (!c?.worktreeId) {
      throw new Error(`no case ${name}`)
    }
    return resolveOwner(c.state, { workspaceId: c.worktreeId })
  }

  it('refuses folder and project-group twins the deprecated resolver sends to the focused runtime', () => {
    expect(LEGACY_RUNTIME_OWNER_GOLDEN['single focus | folder:twin-folder']).toBe('focused-env')
    expect(ownerOf('single focus | folder:twin-folder')).toEqual({ kind: 'ambiguous' })
    expect(LEGACY_RUNTIME_OWNER_GOLDEN['single focus | folder:group-twin-folder']).toBe(
      'focused-env'
    )
    expect(ownerOf('single focus | folder:group-twin-folder')).toEqual({ kind: 'ambiguous' })
  })

  it('keeps the SSH target behind a server the deprecated resolver reduces to an environment id', () => {
    expect(LEGACY_RUNTIME_OWNER_GOLDEN['focused | hub-repo::wt']).toBe('hub-env')
    expect(ownerOf('focused | hub-repo::wt')).toEqual({
      kind: 'resolved',
      owner: { endpoint: { kind: 'environment', environmentId: 'hub-env' }, at: 'ssh:box' }
    })
  })

  it('keeps git-worktree twins ambiguous, as the deprecated resolver already does', () => {
    expect(ownerOf('focused | twin-repo::wt')).toEqual({ kind: 'ambiguous' })
  })
})
