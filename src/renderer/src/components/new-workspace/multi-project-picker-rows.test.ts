import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import { buildMultiProjectPickerRows } from './multi-project-picker-rows'

function option(projectId: string): NewWorkspaceProjectOption {
  return {
    kind: 'project',
    id: projectId,
    projectId,
    displayName: projectId,
    badgeColor: '#000',
    detail: `/code/${projectId}`
  }
}

function setup(projectId: string, patch: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: `${projectId}-${patch.hostId ?? 'local'}`,
    projectId,
    hostId: 'local',
    repoId: `repo-${projectId}`,
    path: `/code/${projectId}`,
    displayName: projectId,
    kind: 'git',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }
}

describe('buildMultiProjectPickerRows', () => {
  const options = ['api', 'web', 'infra', 'docs'].map(option)

  it('puts projects without a setup on the host after the divider with a reason', () => {
    const setups = [
      setup('api'),
      setup('web', { hostId: 'runtime:a' }),
      setup('infra', { connectionId: 'c' })
    ]
    const rows = buildMultiProjectPickerRows(options, setups, 'local', [])
    expect(rows.available.map((row) => row.option.projectId)).toEqual(['api'])
    expect(rows.unavailable.map((row) => [row.option.projectId, row.unavailable])).toEqual([
      ['web', 'no_setup_on_host'],
      ['infra', 'direct_ssh'],
      ['docs', 'no_setup_on_host']
    ])
  })

  it('offers the other host only when exactly one alternative exists', () => {
    const one = buildMultiProjectPickerRows(
      options,
      [setup('web', { hostId: 'runtime:a' })],
      'local',
      []
    )
    expect(one.unavailable.find((row) => row.option.projectId === 'web')?.alternativeHostId).toBe(
      'runtime:a'
    )
    const many = buildMultiProjectPickerRows(
      options,
      [setup('web', { hostId: 'runtime:a' }), setup('web', { hostId: 'runtime:b' })],
      'local',
      []
    )
    expect(
      many.unavailable.find((row) => row.option.projectId === 'web')?.alternativeHostId
    ).toBeNull()
  })

  it('keeps a selected project without a setup in the list so it can be removed', () => {
    const rows = buildMultiProjectPickerRows(options, [setup('api')], 'runtime:a', ['api'])
    expect(
      rows.available.map((row) => [row.option.projectId, row.selected, row.unavailable])
    ).toEqual([['api', true, 'no_setup_on_host']])
  })

  it('blocks unselected rows at the member limit but not selected ones', () => {
    const many = Array.from({ length: 13 }, (_, i) => `p${i}`)
    const setups = many.map((id) => setup(id))
    const selected = many.slice(0, 12)
    const rows = buildMultiProjectPickerRows(many.map(option), setups, 'local', selected)
    expect(rows.unavailable.map((row) => [row.option.projectId, row.unavailable])).toEqual([
      ['p12', 'limit_reached']
    ])
    expect(rows.available).toHaveLength(12)
  })
})
