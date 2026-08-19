import {
  TERMINAL_CONTROL_CHARACTER_PATTERN,
  stripAnsiEscapeSequences
} from '../ansi-escape-sequences'
import type {
  LinearBoundedEntityCollection,
  LinearBoundedNullableString,
  LinearBoundedString,
  LinearProjectLabelsResult,
  LinearProjectShowResult,
  LinearProjectStatusesResult,
  LinearProjectUpdateHealth,
  LinearProjectUpdateNode,
  LinearWorkspaceFanoutMeta
} from './project-agent-access'

/**
 * Single source of human-readable project rendering: the local CLI and the SSH
 * remote shim both print these exact bytes, so an agent sees one output shape.
 * Keep this module free of node-only imports — it is bundled into web builds.
 */

const PRIORITY_LABELS = ['none', 'urgent', 'high', 'medium', 'low']
const HEALTH_LABELS: Record<LinearProjectUpdateHealth, string> = {
  onTrack: 'on-track',
  atRisk: 'at-risk',
  offTrack: 'off-track'
}
const STATUS_NAME_COLUMN_WIDTH = 28
const STATUS_TYPE_COLUMN_WIDTH = 10
const WORKSPACE_COLUMN_WIDTH = 20
const LABEL_NAME_COLUMN_WIDTH = 34

export const LINEAR_PROJECT_STATUSES_NOUN = 'Linear project statuses'
export const LINEAR_PROJECT_LABELS_NOUN = 'Linear project labels'

/** Strip terminal control sequences from untrusted Linear text before printing. */
export function sanitizeLinearProjectText(value: string): string {
  return stripAnsiEscapeSequences(value).replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
}

/** Sanitize and collapse every line break, for fields rendered on one row. */
export function toSingleLineLinearProjectText(value: string): string {
  return sanitizeLinearProjectText(value)
    .replace(/[\t\r\n]+/g, ' ')
    .trim()
}

export function formatLinearProjectShow(result: LinearProjectShowResult): string {
  const project = result.project
  const lines = [
    `${toSingleLineLinearProjectText(project.name)} (${project.slugId})`,
    `URL: ${project.url}`,
    `Workspace: ${toSingleLineLinearProjectText(result.meta.workspaceName)} (${result.meta.workspaceId}) via ${result.meta.resolvedBy}`,
    `Status: ${toSingleLineLinearProjectText(project.status.name)} (${project.status.type})`,
    `Health: ${formatHealth(project.health)}${project.healthUpdatedAt ? ` updated ${project.healthUpdatedAt}` : ''}`,
    `Lead: ${project.lead ? toSingleLineLinearProjectText(project.lead.displayName) : 'none'}`,
    `Priority: ${PRIORITY_LABELS[project.priority] ?? 'none'}`,
    `Dates: ${project.startDate ?? 'none'} -> ${project.targetDate ?? 'none'}`,
    `Color: ${sanitizeLinearProjectText(project.color)}  Icon: ${project.icon ? sanitizeLinearProjectText(project.icon) : 'none'}`,
    formatCollectionLine('Teams', project.teams, (team) => `${team.key} ${team.name}`),
    formatCollectionLine('Members', project.members, (member) => member.displayName),
    formatCollectionLine('Labels', project.labels, (label) =>
      label.parent ? `${label.parent.name}/${label.name}` : label.name
    ),
    ...formatBoundedTextLines('Description', project.description),
    ...formatBoundedTextLines('Content', project.content)
  ]
  if (result.updates) {
    lines.push(...formatUpdateLines(result.updates, result.meta.updates))
  }
  return lines.join('\n')
}

export function formatLinearProjectStatuses(result: LinearProjectStatusesResult): string {
  if (result.statuses.length === 0) {
    return 'No Linear project statuses found.'
  }
  return result.statuses
    .map((status) =>
      [
        padCell(status.name, STATUS_NAME_COLUMN_WIDTH),
        padCell(status.type, STATUS_TYPE_COLUMN_WIDTH),
        padCell(status.workspaceName, WORKSPACE_COLUMN_WIDTH),
        status.id
      ].join(' ')
    )
    .join('\n')
}

export function formatLinearProjectLabels(result: LinearProjectLabelsResult): string {
  if (result.labels.length === 0) {
    return 'No Linear project labels found.'
  }
  return result.labels
    .map((label) =>
      [
        padCell(
          label.parent ? `${label.parent.name}/${label.name}` : label.name,
          LABEL_NAME_COLUMN_WIDTH
        ),
        padCell(label.workspaceName, WORKSPACE_COLUMN_WIDTH),
        label.id
      ].join(' ')
    )
    .join('\n')
}

/** Per-workspace truncation, per-workspace failure, then the partial-fan-out line. */
export function linearProjectFanoutWarningLines(
  meta: LinearWorkspaceFanoutMeta,
  noun: string
): string[] {
  const warnings: string[] = []
  for (const entry of meta.workspaceResults) {
    if (entry.hasMore) {
      warnings.push(
        `warning: ${toSingleLineLinearProjectText(entry.workspace.name)} has more ${noun} than the ${meta.limit} shown; narrow with --query or raise --limit`
      )
    }
  }
  for (const error of meta.workspaceErrors) {
    warnings.push(
      `warning: ${toSingleLineLinearProjectText(error.workspace.name)} unavailable for ${noun}: ${toSingleLineLinearProjectText(error.message)}`
    )
  }
  if (meta.partial) {
    warnings.push(`warning: ${noun} results are partial across workspaces`)
  }
  return warnings
}

function formatUpdateLines(
  updates: LinearProjectUpdateNode[],
  meta: LinearProjectShowResult['meta']['updates']
): string[] {
  if (updates.length === 0) {
    return ['Updates: none']
  }
  const more = meta?.hasMore === true ? ' (more available)' : ''
  const capped = meta?.capReached === true ? ` (capped at ${meta.cap})` : ''
  const lines = [`Updates: ${updates.length}${more}${capped}`]
  for (const update of updates) {
    lines.push(
      `  ${update.createdAt} ${toSingleLineLinearProjectText(update.user.displayName)} ${formatHealth(update.health)}${update.isStale ? ' (stale)' : ''}`,
      `    ${describeBoundedText(update.body)}`,
      `    ${toSingleLineLinearProjectText(update.body.value)}`
    )
  }
  return lines
}

function formatBoundedTextLines(
  label: string,
  text: LinearBoundedString | LinearBoundedNullableString
): string[] {
  if (text.value === null) {
    return [`${label}: none`]
  }
  return [
    `${label}: ${describeBoundedText(text)}`,
    `  ${toSingleLineLinearProjectText(text.value)}`
  ]
}

function describeBoundedText(text: LinearBoundedString | LinearBoundedNullableString): string {
  return `${text.chars} chars sha256 ${text.sha256}${text.truncated ? ' (truncated)' : ''}`
}

function formatCollectionLine<TItem extends { id: string }>(
  label: string,
  collection: LinearBoundedEntityCollection<TItem>,
  name: (item: TItem) => string
): string {
  const shown = collection.truncated ? ` (showing ${collection.returned})` : ''
  const names = collection.items.map((item) => toSingleLineLinearProjectText(name(item))).join(', ')
  return `${label}: ${collection.total}${shown}${names ? ` - ${names}` : ''} sha256 ${collection.sha256}`
}

function formatHealth(health: LinearProjectUpdateHealth | null): string {
  return health ? (HEALTH_LABELS[health] ?? health) : 'unknown'
}

function padCell(value: string, width: number): string {
  return toSingleLineLinearProjectText(value).padEnd(width)
}
