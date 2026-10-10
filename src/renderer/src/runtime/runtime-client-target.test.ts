import { describe, expect, it } from 'vitest'
import { UNRESOLVED_OWNER_HOST_ID } from '../../../shared/execution-host'
import { hostRouteForAuthority, runtimeTargetForExecutionHostId } from './runtime-client-target'

describe('runtimeTargetForExecutionHostId', () => {
  it('keeps the answers for plain host ids', () => {
    expect(runtimeTargetForExecutionHostId('local')).toEqual({ kind: 'local' })
    expect(runtimeTargetForExecutionHostId('runtime:env%2Fa')).toEqual({
      kind: 'environment',
      environmentId: 'env/a'
    })
    expect(runtimeTargetForExecutionHostId('ssh:box')).toBeNull()
    expect(runtimeTargetForExecutionHostId(UNRESOLVED_OWNER_HOST_ID)).toBeNull()
  })

  it('routes a nested SSH key to the server that owns the target', () => {
    expect(runtimeTargetForExecutionHostId('nested:env-a/box')).toEqual({
      kind: 'environment',
      environmentId: 'env-a'
    })
  })
})

describe('hostRouteForAuthority', () => {
  it('keeps the place beside the target instead of inside it', () => {
    expect(
      hostRouteForAuthority({
        endpoint: { kind: 'environment', environmentId: 'env-a' },
        at: 'ssh:box'
      })
    ).toEqual({ target: { kind: 'environment', environmentId: 'env-a' }, at: 'ssh:box' })
    expect(hostRouteForAuthority({ endpoint: { kind: 'self' }, at: 'ssh:box' })).toEqual({
      target: { kind: 'local' },
      at: 'ssh:box'
    })
  })
})
