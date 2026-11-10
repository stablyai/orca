import { renderToStaticMarkup } from 'react-dom/server'
import type { GitHubProjectRow } from '../../../../shared/github/project-types'
import ProjectCell from './ProjectCell'

export function projectRelationCellText(row: GitHubProjectRow): string[] {
  return ['LINKED_PULL_REQUESTS', 'SUB_ISSUES_PROGRESS'].map((dataType) =>
    renderToStaticMarkup(
      <ProjectCell
        row={row}
        field={{ kind: 'field', id: dataType, name: dataType, dataType }}
        editable={false}
        sourceTarget={{ kind: 'local' }}
      />
    ).replace(/<[^>]*>/g, '')
  )
}
