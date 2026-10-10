import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { setupWithFetchedOwner } from './project-host-routing'
import {
  projectCompatibilityFromRepos,
  getProjectHostSetupOwnerKey
} from './project-compatibility-core'
import { resolveProjectHostSetupMutation } from './project-host-setup-mutation'
import { mergeFetchedReposForHost } from '../repos/repo-catalog-identity'
import { mergeFetchedProjectCompatibilityForHost } from './project-compatibility-host-merge'
import { repoWithFetchedOwner } from '../repos/owner-routing'

import {
  buildSettingsProjectList,
  getSettingsEntryHostSelection,
  getSettingsProjectHostRepo
} from '../../components/settings/settings-project-list'

function setup(hostId: ProjectHostSetup['hostId']): ProjectHostSetup {
  return {
    id: 'same-id',
    projectId: 'project',
    hostId,
    repoId: 'same-id',
    path: '/repo',
    displayName: hostId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}
function repo(hostId: ProjectHostSetup['hostId']): Repo {
  return {
    id: 'same-id',
    path: '/repo',
    displayName: hostId,
    executionHostId: hostId,
    badgeColor: '#000',
    addedAt: 1,
    kind: 'folder'
  }
}

describe('project setup catalog ownership', () => {
  it('captures raw local, legacy self stamp, and private SSH before paired adoption', () => {
    const target = { kind: 'environment', environmentId: 'env-1' } as const
    const adopted = (['local', 'runtime:env-1', 'ssh:private-a', 'ssh:private-b'] as const).map(
      (host) => setupWithFetchedOwner(setup(host), target)
    )
    expect(new Set(adopted.map(getProjectHostSetupOwnerKey)).size).toBe(4)
    for (const row of adopted) {
      expect(row.id).toBe('same-id')
      expect(row.catalogOwnerHostId).toBe('runtime:env-1')
      expect(resolveProjectHostSetupMutation(adopted, { setupId: row.id, owner: row })).toBe(row)
    }
    expect(() => resolveProjectHostSetupMutation(adopted, { setupId: 'same-id' })).toThrow(
      /ambiguous/
    )
  })
  it('prunes a source snapshot while preserving another publisher private SSH row', () => {
    const local = repoWithFetchedOwner(repo('ssh:target'), { kind: 'local' })
    const paired = repoWithFetchedOwner(repo('ssh:target'), {
      kind: 'environment',
      environmentId: 'env-1'
    })
    const legacy = repoWithFetchedOwner(repo('runtime:legacy'), { kind: 'local' })
    expect(mergeFetchedReposForHost([local, paired, legacy], [], 'local')).toEqual([paired])
    expect(mergeFetchedReposForHost([local, paired], [], 'runtime:env-1')).toEqual([local])
  })
  it.each(['ssh:target', 'runtime:legacy'] as const)(
    'removes the last source-owned project for %s without pruning a paired publisher',
    (hostId) => {
      const owned = repoWithFetchedOwner(repo(hostId), { kind: 'local' })
      const previous = projectCompatibilityFromRepos([owned])
      expect(
        mergeFetchedProjectCompatibilityForHost({
          previous,
          fetched: { projects: [], projectHostSetups: [] },
          repos: [],
          hostId: 'local'
        })
      ).toEqual({ projects: [], projectHostSetups: [] })
      const paired = repoWithFetchedOwner(repo(hostId), {
        kind: 'environment',
        environmentId: 'env-1'
      })
      const combined = projectCompatibilityFromRepos([owned, paired])
      const remaining = mergeFetchedProjectCompatibilityForHost({
        previous: combined,
        fetched: projectCompatibilityFromRepos([paired]),
        repos: [paired],
        hostId: 'local'
      })
      expect(remaining.projects).toHaveLength(1)
      expect(remaining.projects[0].sourceRepoIds).toEqual(['same-id'])
      expect(remaining.projectHostSetups).toHaveLength(1)
      expect(remaining.projectHostSetups[0].catalogOwnerHostId).toBe('runtime:env-1')
    }
  )
  it('keeps the session-only settings switcher token on the selected private SSH row', () => {
    const target = { kind: 'environment', environmentId: 'paired' } as const
    const rows = [repo('ssh:a'), repo('ssh:b')].map((row) => repoWithFetchedOwner(row, target))
    const entries = buildSettingsProjectList(rows)
    const entry = entries[0]
    const selected = entry.setups.find((setup) => setup.authoritativeExecutionHostId === 'ssh:b')
    if (!selected) {
      throw new Error('Private setup was lost')
    }
    const token = getProjectHostSetupOwnerKey(selected)
    const selection = getSettingsEntryHostSelection(
      entry,
      { [entry.selectionKey]: selected.hostId },
      { [entry.selectionKey]: token }
    )
    expect(getSettingsProjectHostRepo(entry, rows, selection.hostId, selection.setupId)).toBe(
      rows[1]
    )
    expect(getSettingsProjectHostRepo(entry, rows, selected.hostId, selected.id)).toBeUndefined()
    expect(selected.id).toBe('same-id')
  })
})
