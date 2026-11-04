import type { JiraIssue, JiraProject } from './jira-types'
import type { Repo } from '../repo-types'
import { getRepoExecutionHostId } from '../execution-host'
import type { ExecutionHostId } from '../execution-host'
import { resolveJiraSourceHostId } from './jira-source-host'

export type JiraProjectReference = Pick<JiraProject, 'id' | 'key' | 'name'> & { siteId: string }

export function normalizeJiraProjectReference(
  value: unknown
): JiraProjectReference | null | undefined {
  if (value === null) {
    return null
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('id' in value) ||
    !('key' in value) ||
    !('name' in value) ||
    !('siteId' in value)
  ) {
    return undefined
  }
  const { id, key, name, siteId } = value
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    typeof key !== 'string' ||
    !key.trim() ||
    typeof name !== 'string' ||
    !name.trim() ||
    typeof siteId !== 'string' ||
    !siteId.trim()
  ) {
    return undefined
  }
  return { id: id.trim(), key: key.trim(), name: name.trim(), siteId: siteId.trim() }
}

export function matchesJiraProject(project: JiraProject, reference: JiraProjectReference): boolean {
  return project.siteId === reference.siteId && project.id === reference.id
}

export function findJiraIssueDefaultRepo(
  repos: readonly Repo[],
  issue: JiraIssue,
  hostId: ExecutionHostId
): Repo | null {
  const matches = repos.filter(
    (repo) =>
      resolveJiraSourceHostId({ workspaceHostId: getRepoExecutionHostId(repo) }) === hostId &&
      repo.defaultJiraProject &&
      matchesJiraProject(
        { ...issue.project, siteId: issue.siteId ?? issue.project.siteId },
        repo.defaultJiraProject
      )
  )
  return matches.length === 1 ? matches[0] : null
}

export function restrictJiraQueryToProject(jql: string, project: JiraProjectReference): string {
  let quote: string | null = null
  let orderIndex = -1
  for (let index = 0; index < jql.length; index += 1) {
    const character = jql[index]
    if (quote && character === '\\') {
      index += 1
    } else if (character === quote) {
      quote = null
    } else if (!quote && (character === '"' || character === "'")) {
      quote = character
    } else if (
      !quote &&
      (index === 0 || /\s/.test(character)) &&
      /^\s*ORDER\s+BY\s+/i.test(jql.slice(index))
    ) {
      orderIndex = index
      break
    }
  }
  const clause = orderIndex >= 0 ? jql.slice(0, orderIndex) : jql
  const ordering = orderIndex >= 0 ? jql.slice(orderIndex) : ''
  return `project = ${JSON.stringify(project.id)}${clause.trim() ? ` AND (${clause})` : ''}${ordering.trim() ? ` ${ordering.trim()}` : ''}`
}
