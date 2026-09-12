import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows'
import { repo, worktree, repoMap } from './worktree-list-groups-test-fixtures'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

describe('project groups', () => {
  it('keeps empty project groups visible in project grouping mode', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }

    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [group]
    )

    expect(rows).toEqual([
      expect.objectContaining({
        type: 'header',
        key: 'project-group:group-1',
        label: 'Platform',
        projectGroup: group
      })
    ])
  })

  it('renders grouped repos before their visible worktrees are loaded', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const groupedRepo: Repo = { ...repo, projectGroupId: group.id }

    const rows = buildRows(
      'repo',
      [],
      new Map([[groupedRepo.id, groupedRepo]]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [group],
      new Set([groupedRepo.id])
    )

    expect(rows[0]).toMatchObject({
      type: 'header',
      key: 'project-group:group-1'
    })
    expect(rows[1]).toMatchObject({
      type: 'header',
      key: 'repo:repo-1',
      projectGroupDepth: 1
    })
  })

  it('does not resurrect filtered repos as empty Project Group headers', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const groupedRepo: Repo = { ...repo, projectGroupId: group.id }

    const rows = buildRows(
      'repo',
      [],
      new Map([[groupedRepo.id, groupedRepo]]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-1'
    ])
    expect(rows[0]).toMatchObject({ label: 'Platform' })
  })

  it('keeps sleep-filtered Project Group members as empty project headers', () => {
    // Why: #8865 — Hide sleeping removes workspace cards; membership placeholders
    // must still project the grouped project header so the group count stays honest.
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const sleepingRepo: Repo = {
      ...repo,
      id: 'repo-sleeping',
      displayName: 'sleeping-project',
      projectGroupId: group.id
    }
    const awakeRepo: Repo = {
      ...repo,
      id: 'repo-awake',
      displayName: 'awake-project',
      projectGroupId: group.id
    }
    const awakeWorktree: Worktree = {
      ...worktree,
      id: 'wt-awake',
      repoId: awakeRepo.id,
      path: '/tmp/awake'
    }

    const rows = buildRows(
      'repo',
      [awakeWorktree],
      new Map([
        [sleepingRepo.id, sleepingRepo],
        [awakeRepo.id, awakeRepo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[awakeWorktree.id, awakeWorktree]]),
      false,
      undefined,
      [group],
      new Set([sleepingRepo.id])
    )

    expect(rows[0]).toMatchObject({
      type: 'header',
      key: 'project-group:group-1',
      count: 2
    })
    // Why: empty/placeholder projects sort after projects with visible activity.
    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-1',
      `repo:${awakeRepo.id}`,
      `repo:${sleepingRepo.id}`
    ])
  })

  it('renders ungrouped repos as top-level repo rows when Project Groups exist', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }

    const rows = buildRows(
      'repo',
      [worktree],
      repoMap,
      null,
      new Set(),
      new Map([[repo.id, 0]]),
      undefined,
      'manual',
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-1',
      'repo:repo-1'
    ])
  })

  it('renders repos whose Project Group metadata is missing as top-level repo rows', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const repoWithMissingGroup: Repo = { ...repo, projectGroupId: 'missing-group' }

    const rows = buildRows(
      'repo',
      [worktree],
      new Map([[repoWithMissingGroup.id, repoWithMissingGroup]]),
      null,
      new Set(),
      new Map([[repoWithMissingGroup.id, 0]]),
      undefined,
      'manual',
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-1',
      'repo:repo-1'
    ])
    expect(rows.find((row) => row.type === 'header' && row.key === 'repo:repo-1')).toMatchObject({
      projectGroupDepth: 0
    })
  })

  it('does not render collapsed child-group repos as missing metadata fallbacks', () => {
    const parentGroup: ProjectGroup = {
      id: 'parent-group',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const childGroup: ProjectGroup = {
      ...parentGroup,
      id: 'child-group',
      name: 'Services',
      parentPath: '/platform/services',
      parentGroupId: parentGroup.id
    }
    const repoInChildGroup: Repo = { ...repo, projectGroupId: childGroup.id }

    const rows = buildRows(
      'repo',
      [worktree],
      new Map([[repoInChildGroup.id, repoInChildGroup]]),
      null,
      new Set(['project-group:parent-group']),
      new Map([[repoInChildGroup.id, 0]]),
      undefined,
      'manual',
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [parentGroup, childGroup]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:parent-group'
    ])
  })

  it('disambiguates duplicate top-level repo basenames without renaming repos', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const paymentsApi: Repo = {
      ...repo,
      id: 'repo-payments-api',
      path: '/workspace/platform/payments/api',
      displayName: 'api'
    }
    const billingApi: Repo = {
      ...repo,
      id: 'repo-billing-api',
      path: '/workspace/platform/billing/api',
      displayName: 'api'
    }
    const webRepo: Repo = {
      ...repo,
      id: 'repo-web',
      path: '/workspace/platform/web',
      displayName: 'web'
    }
    const repos = new Map([
      [paymentsApi.id, paymentsApi],
      [billingApi.id, billingApi],
      [webRepo.id, webRepo]
    ])
    const worktrees = [
      { ...worktree, id: 'wt-payments-api', repoId: paymentsApi.id },
      { ...worktree, id: 'wt-billing-api', repoId: billingApi.id },
      { ...worktree, id: 'wt-web', repoId: webRepo.id }
    ]

    const rows = buildRows(
      'repo',
      worktrees,
      repos,
      null,
      new Set(),
      new Map([
        [paymentsApi.id, 0],
        [billingApi.id, 1],
        [webRepo.id, 2]
      ]),
      undefined,
      'manual',
      {},
      new Map(worktrees.map((entry) => [entry.id, entry])),
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.label)).toEqual([
      'Platform',
      'payments/api',
      'billing/api',
      'web'
    ])
    expect(paymentsApi.displayName).toBe('api')
    expect(billingApi.displayName).toBe('api')
  })

  it('disambiguates duplicate repo basenames inside each Project Group scope', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const paymentsApi: Repo = {
      ...repo,
      id: 'repo-payments-api',
      path: '/workspace/platform/payments/api',
      displayName: 'api',
      projectGroupId: group.id,
      projectGroupOrder: 0
    }
    const billingApi: Repo = {
      ...repo,
      id: 'repo-billing-api',
      path: '/workspace/platform/billing/api',
      displayName: 'api',
      projectGroupId: group.id,
      projectGroupOrder: 1
    }
    const webRepo: Repo = {
      ...repo,
      id: 'repo-web',
      path: '/workspace/platform/web',
      displayName: 'web',
      projectGroupId: group.id,
      projectGroupOrder: 2
    }
    const repos = new Map([
      [paymentsApi.id, paymentsApi],
      [billingApi.id, billingApi],
      [webRepo.id, webRepo]
    ])
    const worktrees = [
      { ...worktree, id: 'wt-payments-api', repoId: paymentsApi.id },
      { ...worktree, id: 'wt-billing-api', repoId: billingApi.id },
      { ...worktree, id: 'wt-web', repoId: webRepo.id }
    ]

    const rows = buildRows(
      'repo',
      worktrees,
      repos,
      null,
      new Set(),
      new Map([
        [paymentsApi.id, 0],
        [billingApi.id, 1],
        [webRepo.id, 2]
      ]),
      undefined,
      'manual',
      {},
      new Map(worktrees.map((entry) => [entry.id, entry])),
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.label)).toEqual([
      'Platform',
      'payments/api',
      'billing/api',
      'web'
    ])
    expect(paymentsApi.displayName).toBe('api')
    expect(billingApi.displayName).toBe('api')
  })
})
