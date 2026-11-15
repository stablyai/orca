import { defineFixture } from '../../../component-fixtures/component-fixture'
import { projectRelationsTableFixture } from '../../../../../shared/github/projects/project-relations.test-fixture'
import ProjectViewList from './ProjectViewList'

const table = projectRelationsTableFixture()
const repository = {
  kind: 'field',
  id: 'repo',
  name: 'Repository',
  dataType: 'REPOSITORY'
} as const
const parent = {
  kind: 'field',
  id: 'parent',
  name: 'Parent issue',
  dataType: 'PARENT_ISSUE'
} as const
const title = { kind: 'field', id: 'title', name: 'Title', dataType: 'TITLE' } as const
const base = table.rows[0]
table.rows = [101, 9, 2].map((number, position) => ({
  ...base,
  id: `child-${number}`,
  position,
  content: {
    ...base.content,
    title: `Deliver milestone ${number}`,
    repository: position === 2 ? 'acme/tools' : 'acme/app',
    parentIssue: { number, title: 'Milestone', url: `https://github.com/acme/app/issues/${number}` }
  }
}))
table.selectedView.fields = [title, parent, repository, ...table.selectedView.fields.slice(1)]
table.selectedView.groupByFields = [repository]
table.selectedView.sortByFields = [{ field: parent, direction: 'ASC' }]
table.totalCount = table.rows.length

export const contentFields = defineFixture({
  width: 1280,
  render: () => <ProjectViewList table={table} sourceTarget={{ kind: 'local' }} />
})
