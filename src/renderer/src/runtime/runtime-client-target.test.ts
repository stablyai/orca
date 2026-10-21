import { describe, expect, it } from 'vitest'
import { UNRESOLVED_OWNER_HOST_ID } from '../../../shared/execution-host'
import {
  hostRouteForAuthority,
  runtimeRpcTargetForAuthorityKey,
  runtimeTargetForOwnerEnvironment,
  ipcOrRuntimeTargetForHostId
} from './runtime-client-target'

describe('runtimeRpcTargetForAuthorityKey', () => {
  it('keeps the answers for plain host ids', () => {
    expect(runtimeRpcTargetForAuthorityKey('local')).toEqual({ kind: 'local' })
    expect(runtimeRpcTargetForAuthorityKey('runtime:env%2Fa')).toEqual({
      kind: 'environment',
      environmentId: 'env/a'
    })
    expect(runtimeRpcTargetForAuthorityKey('ssh:box')).toBeNull()
    expect(runtimeRpcTargetForAuthorityKey(UNRESOLVED_OWNER_HOST_ID)).toBeNull()
  })

  it('routes a nested SSH key to the server that owns the target', () => {
    expect(runtimeRpcTargetForAuthorityKey('nested:env-a/box')).toEqual({
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

describe('owner transports', () => {
  it('maps an owner environment id, with null as this app', () => {
    expect(runtimeTargetForOwnerEnvironment(null)).toEqual({ kind: 'local' })
    expect(runtimeTargetForOwnerEnvironment(' ')).toEqual({ kind: 'local' })
    expect(runtimeTargetForOwnerEnvironment(' env-a ')).toEqual({
      kind: 'environment',
      environmentId: 'env-a'
    })
  })

  it('routes local and direct SSH owners through this app and never dials the sentinel', () => {
    expect(ipcOrRuntimeTargetForHostId('local')).toEqual({ kind: 'local' })
    expect(ipcOrRuntimeTargetForHostId('ssh:box')).toEqual({ kind: 'local' })
    expect(ipcOrRuntimeTargetForHostId('runtime:env%2Fa')).toEqual({
      kind: 'environment',
      environmentId: 'env/a'
    })
    expect(ipcOrRuntimeTargetForHostId(UNRESOLVED_OWNER_HOST_ID)).toBeNull()
    expect(ipcOrRuntimeTargetForHostId(undefined)).toBeNull()
  })
})
