import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { findRepoForHost } from './repo-host-identity'

const local: Repo = {
  id: 'shared',
  path: '/local',
  displayName: 'Local',
  badgeColor: '',
  addedAt: 1
}
const a: Repo = {
  ...local,
  executionHostId: 'runtime:hub',
  catalogOwnerHostId: 'runtime:hub',
  authoritativeExecutionHostId: 'ssh:a'
}
const b: Repo = { ...a, authoritativeExecutionHostId: 'ssh:b' }

describe.each([
  ['forward', [a, b]],
  ['reverse', [b, a]]
] as const)('qualified repository lookup: %s', (_order, repos) => {
  it('refuses an explicit display host with multiple raw owners', () => {
    expect(findRepoForHost(repos, local.id, { hostId: 'runtime:hub' })).toBeNull()
  })

  it('uses the separate raw owner and catalog publisher qualifiers', () => {
    expect(
      findRepoForHost(repos, local.id, {
        hostId: 'runtime:hub',
        catalogOwnerHostId: 'runtime:hub',
        authoritativeExecutionHostId: 'ssh:b'
      })
    ).toBe(b)
  })

  it('refuses missing or mismatched explicit ownership without falling back to focus', () => {
    expect(
      findRepoForHost(repos, local.id, {
        hostId: 'runtime:hub',
        authoritativeExecutionHostId: 'ssh:missing',
        settings: { activeRuntimeEnvironmentId: 'hub' }
      })
    ).toBeNull()
    expect(
      findRepoForHost(repos, local.id, {
        hostId: 'runtime:hub',
        catalogOwnerHostId: 'runtime:other',
        authoritativeExecutionHostId: 'ssh:b'
      })
    ).toBeNull()
  })
})

it('distinguishes the same raw owner published by two runtimes', () => {
  const other: Repo = {
    ...b,
    executionHostId: 'runtime:other',
    catalogOwnerHostId: 'runtime:other'
  }
  expect(
    findRepoForHost([other, b], local.id, {
      catalogOwnerHostId: 'runtime:hub',
      authoritativeExecutionHostId: 'ssh:b'
    })
  ).toBe(b)
})

it('does not treat a legacy runtime row with unknown raw host as an explicit SSH owner', () => {
  expect(
    findRepoForHost([{ ...local, executionHostId: 'runtime:hub' }], local.id, {
      hostId: 'runtime:hub',
      authoritativeExecutionHostId: 'ssh:b'
    })
  ).toBeNull()
  expect(
    findRepoForHost([{ ...local, executionHostId: 'runtime:hub' }], local.id, {
      hostId: 'runtime:hub',
      authoritativeExecutionHostId: 'runtime:hub'
    })
  ).toBeNull()
})

it('retains proven legacy relayed SSH ownership', () => {
  const legacy: Repo = { ...local, executionHostId: 'runtime:hub', connectionId: 'b' }
  expect(
    findRepoForHost([legacy], local.id, {
      hostId: 'runtime:hub',
      authoritativeExecutionHostId: 'ssh:b'
    })
  ).toBe(legacy)
})

it('preserves unique local, direct SSH, runtime, and focused selection', () => {
  const direct = { ...local, connectionId: 'b' }
  expect(findRepoForHost([local], local.id)).toBe(local)
  expect(findRepoForHost([local, direct], local.id, { hostId: 'local' })).toBe(local)
  expect(findRepoForHost([local, direct], local.id, { hostId: 'ssh:b' })).toBe(direct)
  expect(findRepoForHost([local, b], local.id)).toBe(local)
  expect(
    findRepoForHost([local, b], local.id, {
      settings: { activeRuntimeEnvironmentId: 'hub' }
    })
  ).toBe(b)
  expect(findRepoForHost([local, b], local.id, { hostId: 'runtime:hub' })).toBe(b)
})
