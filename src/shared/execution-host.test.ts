import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  getRepoDialableSshTargetId,
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  getWorktreeExecutionHostId,
  isRepoOnCatalogHost,
  isUnresolvedOwnerHostId,
  parseExecutionHostId,
  parseRoutableExecutionHostId,
  requestedExecutionHostScope,
  toSshExecutionHostId,
  UNRESOLVED_OWNER_HOST_ID
} from './execution-host'

describe('execution host identity', () => {
  // Restore navigator stubs between tests to prevent suite leakage.
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults an omitted scope request to this host, not a fan-out', () => {
    expect(requestedExecutionHostScope(undefined)).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(requestedExecutionHostScope(null)).toBe(LOCAL_EXECUTION_HOST_ID)
    // An empty or unrecognized scope is a real value, so it still fans out.
    expect(requestedExecutionHostScope('')).toBe(ALL_EXECUTION_HOSTS_SCOPE)
    expect(requestedExecutionHostScope('bogus')).toBe(ALL_EXECUTION_HOSTS_SCOPE)
    expect(requestedExecutionHostScope('all')).toBe(ALL_EXECUTION_HOSTS_SCOPE)
    expect(requestedExecutionHostScope('ssh:dev%20box')).toBe('ssh:dev%20box')
  })

  it('prefers explicit worktree ownership before repo and focused-host fallbacks', () => {
    expect(
      getWorktreeExecutionHostId(
        { hostId: 'runtime:workspace-owner' },
        { connectionId: 'repo-owner' },
        'runtime:focused-host'
      )
    ).toBe('runtime:workspace-owner')
    expect(
      getWorktreeExecutionHostId({}, { connectionId: 'repo-owner' }, 'runtime:focused-host')
    ).toBe('ssh:repo-owner')
    expect(getWorktreeExecutionHostId({}, {}, 'runtime:focused-host')).toBe('runtime:focused-host')
  })

  // Runtime nested targets hold files but require their environment to dial; pane reads and client PTY routing need different answers.
  it('distinguishes the SSH target holding a row from the connection this client may dial', () => {
    expect(getRepoSshConnectionId({ connectionId: 'openclaw' })).toBe('openclaw')
    expect(getRepoDialableSshTargetId({ connectionId: 'openclaw' })).toBe('openclaw')
    expect(getRepoSshConnectionId({ executionHostId: 'ssh:m4air' })).toBe('m4air')
    expect(getRepoDialableSshTargetId({ executionHostId: 'ssh:m4air' })).toBe('m4air')

    // A stale connectionId contradicts local, which has no nested SSH namespace.
    expect(
      getRepoSshConnectionId({ executionHostId: 'local', connectionId: 'openclaw' })
    ).toBeNull()
    expect(
      getRepoDialableSshTargetId({ executionHostId: 'local', connectionId: 'openclaw' })
    ).toBeNull()

    // Keep runtime-nested targets or transcript routing would mistake their files for client-local files.
    expect(
      getRepoSshConnectionId({ executionHostId: 'runtime:env-a', connectionId: 'ssh-nested' })
    ).toBe('ssh-nested')
    // The nested id alone is not client-dialable.
    expect(
      getRepoDialableSshTargetId({ executionHostId: 'runtime:env-a', connectionId: 'ssh-nested' })
    ).toBeNull()
    expect(getRepoSshConnectionId({ executionHostId: 'runtime:env-a' })).toBeNull()

    // An ephemeral-VM target is an ordinary client-dialable target and stays an `ssh:` host.
    expect(getRepoSshConnectionId({ connectionId: 'runtime-ssh-vm-1' })).toBe('runtime-ssh-vm-1')
    expect(getRepoExecutionHostId({ connectionId: 'runtime-ssh-vm-1' })).toBe(
      'ssh:runtime-ssh-vm-1'
    )
  })
})

describe('execution host id delimiter invariant', () => {
  it('rejects an unencoded pipe so a crafted id cannot rebind a worktree identity alias', () => {
    // composeWorktreeHostIdentity splits at the first `|`, so `ssh:a|b` would resolve as `ssh:a`.
    expect(parseExecutionHostId('ssh:a|b')).toBeNull()
    expect(parseExecutionHostId('runtime:a|b')).toBeNull()
    expect(parseExecutionHostId(toSshExecutionHostId('a|b'))).toEqual({
      kind: 'ssh',
      id: 'ssh:a%7Cb',
      targetId: 'a|b'
    })
  })
})

describe('unresolved-owner sentinel', () => {
  it('parses as a runtime host so nothing treats it as local, but is never routable', () => {
    expect(parseExecutionHostId(UNRESOLVED_OWNER_HOST_ID)?.kind).toBe('runtime')
    expect(isUnresolvedOwnerHostId(UNRESOLVED_OWNER_HOST_ID)).toBe(true)
    expect(parseRoutableExecutionHostId(UNRESOLVED_OWNER_HOST_ID)).toBeNull()
    expect(parseRoutableExecutionHostId('runtime:env-1')?.id).toBe('runtime:env-1')
    expect(isUnresolvedOwnerHostId('runtime:env-1')).toBe(false)
  })
})

describe('isRepoOnCatalogHost', () => {
  it('counts only rows whose files are on the catalog’s own machine', () => {
    expect(isRepoOnCatalogHost({})).toBe(true)
    expect(isRepoOnCatalogHost({ connectionId: null, executionHostId: 'local' })).toBe(true)
    expect(isRepoOnCatalogHost({ connectionId: '  ' })).toBe(true)
    expect(isRepoOnCatalogHost({ connectionId: 'ssh-1' })).toBe(false)
    expect(isRepoOnCatalogHost({ executionHostId: 'ssh:ssh-1' })).toBe(false)
    expect(isRepoOnCatalogHost({ executionHostId: 'runtime:env-1' })).toBe(false)
    // A stale connection id contradicts `local`; an unknown host id is not proven local.
    expect(isRepoOnCatalogHost({ executionHostId: 'local', connectionId: 'ssh-1' })).toBe(false)
    expect(isRepoOnCatalogHost({ executionHostId: 'future:host' })).toBe(false)
  })
})
