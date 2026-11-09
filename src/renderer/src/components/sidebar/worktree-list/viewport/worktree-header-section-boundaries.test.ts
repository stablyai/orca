import { expect, it } from 'vitest'
import type { RenderRow } from '../listing/render-row'
import { getRootProjectHeaderSectionEndByKey } from './worktree-header-section-boundaries'

it('ends a root group before a removed project header and its pending creation', () => {
  const rows: RenderRow[] = [
    {
      type: 'header',
      key: 'group:projects',
      count: 1,
      icon: { kind: 'project' },
      projectGroup: {
        id: 'projects',
        name: 'Projects',
        parentPath: null,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      }
    },
    {
      type: 'header',
      key: 'repo:member',
      count: 0,
      icon: { kind: 'project' },
      repo: { id: 'member', path: '/member', displayName: 'Member', badgeColor: '', addedAt: 1 },
      projectGroupDepth: 1
    },
    { type: 'header', key: 'repo:removed', count: 0, icon: { kind: 'project' } },
    { type: 'pending-creation', key: 'creation', creationId: 'creation', repo: undefined }
  ]

  expect([...getRootProjectHeaderSectionEndByKey(rows, 0).values()]).toEqual([60])
})
