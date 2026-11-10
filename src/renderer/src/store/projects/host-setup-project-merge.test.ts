import { describe, expect, it } from 'vitest'
import type { Project } from '../../../../shared/project-types'
import { upsertHostSetupProject } from './host-setup-project-merge'

function project(overrides: Partial<Project>): Project {
  return {
    id: 'github:acme/orca-sandbox-push-test',
    displayName: 'orca-sandbox-push-test',
    sourceRepoIds: ['local-repo'],
    badgeColor: '#888888',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as Project
}

describe('upsertHostSetupProject', () => {
  it('keeps the existing project name when an Orca Cloud sandbox reports its checkout as "project"', () => {
    const existing = project({})
    const fromSandbox = project({ displayName: 'project', sourceRepoIds: ['vm-repo'] })
    const [merged, ...rest] = upsertHostSetupProject([existing], fromSandbox, true)
    expect(rest).toEqual([])
    expect(merged!.displayName).toBe('orca-sandbox-push-test')
    // The sandbox checkout joins the existing project instead of replacing its repos.
    expect(merged!.sourceRepoIds).toEqual(['local-repo', 'vm-repo'])
  })

  it('adds a project this computer has never seen under the host’s name', () => {
    const fromSandbox = project({ id: 'github:acme/new', displayName: 'new' })
    expect(upsertHostSetupProject([project({})], fromSandbox, true).map((p) => p.id)).toEqual([
      'github:acme/orca-sandbox-push-test',
      'github:acme/new'
    ])
  })

  it('lets a local setup rename the project', () => {
    const renamed = project({ displayName: 'Renamed locally' })
    expect(upsertHostSetupProject([project({})], renamed, false)[0]!.displayName).toBe(
      'Renamed locally'
    )
  })
})
