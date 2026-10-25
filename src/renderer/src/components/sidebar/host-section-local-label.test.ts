import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Row } from '../../../../shared/sidebar-list/row-types'
import { addHostSectionRows } from '../../../../shared/sidebar-list/host-section-rows'

function repoHeader(id: string, connectionId?: string): Row {
  const repo: Repo = {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '',
    addedAt: 0,
    connectionId
  }
  return {
    type: 'header',
    key: `repo:${id}`,
    label: id,
    count: 1,
    icon: { kind: 'project' },
    repo
  }
}

describe('addHostSectionRows local host label', () => {
  // The client’s platform must not determine the listed host’s label.
  it('names an unlisted local host with the label it is given', () => {
    const sectioned = addHostSectionRows({
      rows: [repoHeader('local'), repoHeader('ssh', 'ssh-1')],
      hostOptions: [
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' },
        { id: 'ssh:ssh-2', kind: 'ssh', label: 'Other', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds: ['local', 'ssh:ssh-1'],
      defaultHostId: 'local',
      localHostLabel: 'Local Windows'
    })
    expect(
      sectioned.find((row) => row.type === 'host-header' && row.hostId === 'local')
    ).toMatchObject({ label: 'Local Windows', detail: 'This computer' })
  })
})
