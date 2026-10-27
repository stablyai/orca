import { expect, it } from 'vitest'
import { getProjectHostSetupLookup } from './project-host-setup-lookup'

it('keeps host twins, nested SSH and independent setups distinct while resolving current affiliation', () => {
  const owners = getProjectHostSetupLookup([
    { id: 'repo', repoId: 'repo', hostId: 'local', projectId: 'local-project' },
    { id: 'repo', repoId: 'repo', hostId: 'runtime:hub', projectId: 'hub-project' },
    {
      id: 'nested',
      repoId: 'repo',
      hostId: 'runtime:hub',
      executionHostId: 'ssh:target',
      projectId: 'nested-project'
    },
    { id: 'independent', repoId: '', hostId: 'local', projectId: 'independent-project' }
  ])
  const legacy = { repoId: 'repo', projectId: 'saved-project' }
  expect(owners.projectId({ ...legacy, hostId: 'local' })).toBe('local-project')
  expect(owners.projectId({ ...legacy, projectHostSetupId: 'repo', hostId: 'runtime:hub' })).toBe(
    'hub-project'
  )
  expect(
    owners.projectId({ ...legacy, hostId: 'ssh:target', runtimeOwnerEnvironmentId: 'hub' })
  ).toBe('nested-project')
  expect(owners.projectId({ ...legacy, hostId: 'local', projectHostSetupId: 'independent' })).toBe(
    'independent-project'
  )
  expect(owners.projectId(legacy)).toBe('saved-project')
  expect(owners.projectId({ ...legacy, hostId: 'runtime:other' })).toBe('saved-project')
  expect(owners.projectId({ ...legacy, hostId: 'not-a-host' })).toBe('saved-project')
  expect(
    owners.projectId({ ...legacy, hostId: 'local', projectHostSetupId: 'missing-independent' })
  ).toBe('saved-project')
})
