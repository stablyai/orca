import type { LinearComment, LinearIssue } from '../../../shared/types'

export const LINEAR_ISSUE_CONTEXT_CAPS = {
  descriptionChars: 3000,
  comments: 8,
  commentBodyChars: 800,
  childIssues: 10,
  labels: 12,
  renderedTextChars: 12000
} as const

const TRUNCATED_MARKER = '[truncated]'

const LINEAR_PRIORITY_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncateText(value: string, maxChars: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= maxChars) {
    return trimmed
  }
  const suffix = `\n${TRUNCATED_MARKER}`
  const bodyLimit = Math.max(0, maxChars - suffix.length)
  return `${trimmed.slice(0, bodyLimit).trimEnd()}${suffix}`
}

function applyTotalCap(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }

  const suffix = `\n[context truncated to ${maxChars} chars]`
  const budget = maxChars - suffix.length
  if (budget <= 0) {
    return suffix.trim().slice(0, maxChars)
  }

  const lines = value.split('\n')
  let output = ''
  for (const line of lines) {
    const next = output ? `${output}\n${line}` : line
    if (next.length > budget) {
      if (!output) {
        output = line.slice(0, budget).trimEnd()
      }
      break
    }
    output = next
  }

  return `${output.trimEnd()}${suffix}`
}

function getPriorityLabel(priority: number): string {
  return LINEAR_PRIORITY_LABELS[priority] ?? `P${priority}`
}

function formatLabels(labels: string[]): string | null {
  const normalized = labels.map(normalizeInline).filter(Boolean)
  if (normalized.length === 0) {
    return null
  }
  const shown = normalized.slice(0, LINEAR_ISSUE_CONTEXT_CAPS.labels)
  const omitted = normalized.length - shown.length
  if (omitted > 0) {
    shown.push(`[${omitted} more labels]`)
  }
  return shown.join(', ')
}

function sortComments(comments: LinearComment[]): LinearComment[] {
  return comments
    .map((comment, index) => {
      const time = Date.parse(comment.createdAt)
      return {
        comment,
        index,
        time: Number.isNaN(time) ? null : time
      }
    })
    .sort((a, b) => {
      if (a.time !== null && b.time !== null && a.time !== b.time) {
        return b.time - a.time
      }
      if (a.time !== null && b.time === null) {
        return -1
      }
      if (a.time === null && b.time !== null) {
        return 1
      }
      const aId = typeof a.comment.id === 'string' ? a.comment.id.trim() : ''
      const bId = typeof b.comment.id === 'string' ? b.comment.id.trim() : ''
      if (aId && bId && aId !== bId) {
        return aId.localeCompare(bId)
      }
      return a.index - b.index
    })
    .map((entry) => entry.comment)
}

function indentBlock(value: string): string {
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

export function buildLinearIssueContextSnapshot(
  issue: LinearIssue,
  comments: LinearComment[] = []
): string {
  const lines: string[] = [
    'Linear issue context snapshot',
    `Identifier: ${normalizeInline(issue.identifier)}`,
    `Title: ${normalizeInline(issue.title)}`,
    `URL: ${normalizeInline(issue.url)}`,
    `State: ${normalizeInline(issue.state.name)} (${normalizeInline(issue.state.type)})`,
    `Priority: ${getPriorityLabel(issue.priority)} (${issue.priority})`,
    `Estimate: ${issue.estimate ?? 'None'}`,
    `Assignee: ${
      issue.assignee?.displayName ? normalizeInline(issue.assignee.displayName) : 'Unassigned'
    }`,
    `Team: ${normalizeInline(issue.team.name)} (${normalizeInline(issue.team.key)})`
  ]

  const workspace = normalizeInline(issue.workspaceName ?? issue.workspaceId ?? '')
  if (workspace) {
    lines.push(`Workspace: ${workspace}`)
  }

  if (issue.project) {
    const project = normalizeInline(issue.project.name)
    const projectUrl = normalizeInline(issue.project.url ?? '')
    lines.push(`Project: ${project}${projectUrl ? ` (${projectUrl})` : ''}`)
  }

  const labels = formatLabels(issue.labels)
  if (labels) {
    lines.push(`Labels: ${labels}`)
  }

  lines.push(`Updated: ${normalizeInline(issue.updatedAt)}`)

  const description = issue.description?.trim()
  if (description) {
    lines.push(
      '',
      'Description:',
      truncateText(description, LINEAR_ISSUE_CONTEXT_CAPS.descriptionChars)
    )
  }

  const childIssues = issue.subIssues ?? []
  if (childIssues.length > 0) {
    lines.push('', 'Child issues:')
    for (const child of childIssues.slice(0, LINEAR_ISSUE_CONTEXT_CAPS.childIssues)) {
      lines.push(
        `- ${normalizeInline(child.identifier)} ${normalizeInline(child.title)} (${normalizeInline(child.url)})`
      )
    }
    const omitted = childIssues.length - LINEAR_ISSUE_CONTEXT_CAPS.childIssues
    if (omitted > 0) {
      lines.push(`[${omitted} more child issues]`)
    }
  }

  const sortedComments = sortComments(comments)
  if (sortedComments.length > 0) {
    lines.push('', 'Recent comments:')
    for (const comment of sortedComments.slice(0, LINEAR_ISSUE_CONTEXT_CAPS.comments)) {
      const author = normalizeInline(comment.user?.displayName ?? 'Unknown')
      const createdAt = normalizeInline(comment.createdAt)
      const body = truncateText(comment.body, LINEAR_ISSUE_CONTEXT_CAPS.commentBodyChars)
      lines.push(`- ${createdAt} ${author}:`, indentBlock(body || '(empty comment)'))
    }
    const omitted = sortedComments.length - LINEAR_ISSUE_CONTEXT_CAPS.comments
    if (omitted > 0) {
      lines.push(`[${omitted} older comments]`)
    }
  }

  return applyTotalCap(lines.join('\n'), LINEAR_ISSUE_CONTEXT_CAPS.renderedTextChars)
}
