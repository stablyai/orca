import { expect, it } from 'vitest'
import { getRenderedProjectCollapseKeys } from './project-collapse-all'

it('includes project headers without counted workspaces and uses their collapse identities', () => {
  expect(
    getRenderedProjectCollapseKeys([
      { type: 'header', key: 'repo:imports', count: 0, icon: { kind: 'project' } },
      { type: 'header', key: 'repo:inbox', count: 0, icon: { kind: 'project' } },
      { type: 'header', key: 'repo:pending', count: 0, icon: { kind: 'project' } },
      {
        type: 'header',
        key: 'project:one:remote',
        collapseKey: 'project:one',
        count: 2,
        icon: { kind: 'project' }
      },
      {
        type: 'header',
        key: 'project:one:local',
        collapseKey: 'project:one',
        count: 1,
        icon: { kind: 'project' }
      },
      { type: 'header', key: 'pinned', count: 1, icon: { kind: 'pinned' } }
    ])
  ).toEqual(['repo:imports', 'repo:inbox', 'repo:pending', 'project:one'])
})
