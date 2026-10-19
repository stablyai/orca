import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'

const group: ProjectGroup = {
  id: 'g1',
  name: 'Notes',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}

async function catalogWith(switchedOn: boolean) {
  vi.resetModules()
  vi.doMock('../../../../shared/sidebar-inputs-switch', () => ({
    ORCA_SIDEBAR_INPUTS_IS_MAIN: switchedOn
  }))
  const { getProjectSectionCatalogFromState } = await import('./project-section-catalog')
  return getProjectSectionCatalogFromState({
    repos: [],
    projects: [],
    projectHostSetups: [],
    projectOrderBy: 'manual',
    projectGroups: [group]
  })
}

afterEach(() => {
  vi.doUnmock('../../../../shared/sidebar-inputs-switch')
  vi.resetModules()
})

describe('the sidebar catalog the window publishes for the phone', () => {
  it('carries project groups only for a page reading the sidebar feed', async () => {
    expect(await catalogWith(false)).not.toHaveProperty('projectGroups')
    expect((await catalogWith(true))?.projectGroups).toEqual([group])
  })
})
