import type { LinearProjectListResult } from './linear-agent-result-types'

export function formatLinearProjectListRows(result: LinearProjectListResult): string {
  if (result.projects.length === 0) {
    return 'No Linear projects found.'
  }
  return result.projects
    .map((project) => {
      const teams =
        project.teams
          ?.map((team) => team.key ?? team.name)
          .filter(Boolean)
          .join(',') || 'no-teams'
      const workspace = project.workspaceName ? ` ${project.workspaceName}` : ''
      return `${project.name.padEnd(28)} ${project.id} ${teams}${workspace}`
    })
    .join('\n')
}

export function linearProjectListWarningLines(result: LinearProjectListResult): string[] {
  const warnings: string[] = []
  if (result.meta.hasMore) {
    warnings.push(`warning: showing first ${result.meta.returned} Linear projects`)
  }
  for (const error of result.meta.workspaceErrors ?? []) {
    warnings.push(`warning: ${error.workspace.name} unavailable for Linear: ${error.message}`)
  }
  return warnings
}
