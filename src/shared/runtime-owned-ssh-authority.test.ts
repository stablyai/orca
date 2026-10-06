import { expect, it } from 'vitest'
import { admitRuntimeOwnedSshAuthority } from './runtime-owned-ssh-authority'

it('admits host generation tokens and explicit revocations', () => {
  for (const connectionGeneration of [0, Number.MAX_SAFE_INTEGER, null]) {
    const authority = { targetId: 'runtime-ssh-fixture', connectionGeneration }
    expect(admitRuntimeOwnedSshAuthority(authority)).toEqual(authority)
  }
})

it('refuses ordinary targets, unbounded ids, absent fields and invalid tokens', () => {
  for (const value of [
    null,
    {},
    { targetId: 'ssh-user', connectionGeneration: 3 },
    { targetId: `runtime-ssh-${'x'.repeat(1024)}`, connectionGeneration: 3 },
    { targetId: 'runtime-ssh-fixture' },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '3', undefined].map((connectionGeneration) => ({
      targetId: 'runtime-ssh-fixture',
      connectionGeneration
    }))
  ]) {
    expect(admitRuntimeOwnedSshAuthority(value)).toBeNull()
  }
})
