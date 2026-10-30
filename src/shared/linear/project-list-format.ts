import type { LinearProjectListResult } from './agent-result-types'
import { appendLinearListTruncation } from './list-truncation-format'
import { terminalSafeLine as safe } from '../terminal-safe-text'

// Why: non-JSON project output aligns ids with the existing compact Linear tables.
const LINEAR_PROJECT_NAME_COLUMN_WIDTH = 28

export function formatLinearProjectListRows(result: LinearProjectListResult): string {
  if (result.projects.length === 0) {
    return 'No Linear projects found.'
  }
  const body = result.projects
    .map((project) => {
      const teams =
        project.teams
          ?.map((team) => {
            const key = team.key?.trim()
            return safe(key ? key : team.name)
          })
          .filter(Boolean)
          .join(',') || 'no-teams'
      const workspace = project.workspaceName ? ` ${safe(project.workspaceName)}` : ''
      return `${safe(project.name).padEnd(LINEAR_PROJECT_NAME_COLUMN_WIDTH)} ${safe(project.id)} ${teams}${workspace}`
    })
    .join('\n')
  return appendLinearListTruncation(
    body,
    result.projects.length,
    result.truncated ?? result.meta.hasMore
  )
}

export function linearProjectListWarningLines(result: LinearProjectListResult): string[] {
  const warnings: string[] = []
  if (result.meta.hasMore) {
    warnings.push(`warning: showing first ${result.meta.returned} Linear projects`)
  }
  for (const error of result.meta.workspaceErrors ?? []) {
    warnings.push(
      `warning: ${safe(error.workspace.name)} unavailable for Linear: ${safe(error.message)}`
    )
  }
  return warnings
}
