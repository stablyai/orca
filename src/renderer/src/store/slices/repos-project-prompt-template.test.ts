import { expect, it, vi } from 'vitest'
import type { Project } from '../../../../shared/project-types'
import { createTestStore } from './store-test-helpers'

it('rejects unapplied templates from older hosts and accepts an explicit reset', async () => {
  const project: Project = {
    id: 'project-1',
    displayName: 'Project',
    badgeColor: '#000',
    sourceRepoIds: ['local-repo'],
    createdAt: 1,
    updatedAt: 1,
    linkedWorkItemPromptTemplate: '{url} /old'
  }
  const { linkedWorkItemPromptTemplate: _template, ...withoutTemplate } = project
  const update = vi.fn().mockResolvedValue(withoutTemplate)
  vi.stubGlobal('window', { api: { projects: { update } } })
  const store = createTestStore()
  store.setState({ projects: [project] })
  expect(
    await store
      .getState()
      .updateProject(project.id, { linkedWorkItemPromptTemplate: '{url} /new' }, 'local')
  ).toBe(false)
  expect(store.getState().projects[0]?.linkedWorkItemPromptTemplate).toBe('{url} /old')
  expect(
    await store.getState().updateProject(project.id, { linkedWorkItemPromptTemplate: null }, 'local')
  ).toBe(true)
  expect(store.getState().projects[0]?.linkedWorkItemPromptTemplate).toBeUndefined()
})
