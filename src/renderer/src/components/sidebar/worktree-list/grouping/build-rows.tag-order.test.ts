import { describe, expect, it } from 'vitest'
import { buildRows } from './build-rows'
import type { Row } from './row-types'
import type { TagSectionOrder } from './tag-section-order'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import { addHostSectionRows } from '../../host-section-rows'
import { normalizeManualTagOrder } from '../../../../../../shared/worktree/manual-tag-order'
import type { Worktree } from '../../../../../../shared/worktree/types'

const repoMap = new Map([[repo.id, repo]])

function makeWorktree(id: string, tags: string[], lastActivityAt: number): Worktree {
  return { ...worktree, id, path: `/tmp/${id}`, displayName: id, tags, lastActivityAt }
}

function tagHeaders(worktrees: Worktree[], tagOrder: TagSectionOrder): string[] {
  const rows = buildRows(
    'tag',
    worktrees,
    repoMap,
    null,
    new Set<string>(),
    undefined,
    undefined,
    'manual',
    {},
    new Map(worktrees.map((entry) => [entry.id, entry])),
    false,
    undefined,
    [],
    new Set(),
    new Map(),
    new Map(),
    [],
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    tagOrder
  )
  return rows
    .filter((row): row is Extract<Row, { type: 'header' }> => row.type === 'header')
    .map((row) => row.label)
}

describe('tag section order', () => {
  const billing = makeWorktree('billing', ['Billing'], 10)
  const infra = makeWorktree('infra', ['Infra'], 30)
  const ui = makeWorktree('ui', ['UI'], 20)
  const untagged = makeWorktree('loose', [], 40)
  const worktrees = [billing, infra, ui, untagged]

  it('orders alphabetically by name, Untagged last', () => {
    expect(tagHeaders(worktrees, { by: 'name', manual: [] })).toEqual([
      'Billing',
      'Infra',
      'UI',
      'Untagged'
    ])
  })

  it('orders by most recent agent activity, Untagged last', () => {
    expect(tagHeaders(worktrees, { by: 'activity', manual: [] })).toEqual([
      'Infra',
      'UI',
      'Billing',
      'Untagged'
    ])
  })

  it('follows the stored manual order and appends unlisted tags alphabetically', () => {
    expect(tagHeaders(worktrees, { by: 'manual', manual: ['UI', 'billing'] })).toEqual([
      'UI',
      'Billing',
      'Infra',
      'Untagged'
    ])
  })

  it('falls back to alphabetical while the manual order is still empty', () => {
    expect(tagHeaders(worktrees, { by: 'manual', manual: [] })).toEqual([
      'Billing',
      'Infra',
      'UI',
      'Untagged'
    ])
  })
})

describe('tag headers under host sections', () => {
  it('repeats one tag header per host, which is why manual drag stands down there', () => {
    const local = { ...repo, id: 'local-repo' }
    const remote = { ...repo, id: 'remote-repo', connectionId: 'ssh-1' }
    const rows = buildRows(
      'tag',
      [
        { ...worktree, id: 'local-billing', repoId: local.id, tags: ['Billing'] },
        { ...worktree, id: 'remote-billing', repoId: remote.id, tags: ['Billing'] }
      ],
      new Map([
        [local.id, local],
        [remote.id, remote]
      ]),
      null,
      new Set<string>()
    )
    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        { id: 'local', kind: 'local', label: 'Local', detail: 'This computer', health: 'local' },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds: ['local', 'ssh:ssh-1'],
      defaultHostId: 'local'
    })
    const billingLabels = sectioned.flatMap((row) =>
      row.type === 'header' && row.label === 'Billing' ? [row.label] : []
    )
    expect(billingLabels.length).toBeGreaterThan(1)
    // Why this matters: the drag's ordered list is deduped, so it sees one Billing.
    expect(normalizeManualTagOrder(billingLabels)).toEqual(['Billing'])
  })
})
