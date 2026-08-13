import type { LinearIssue } from '../types'
import {
  parseLinearIssueInput,
  parseLinearIssueUrlIntent,
  type LinearIssueUrlIntent,
  type ParsedLinearIssueInput
} from '../linear-links'
import { isSmartWorkspaceSourceQueryWithinLimit } from './smart-workspace-source-query'

type SmartWorkspaceLinearMode = 'smart' | 'linear' | (string & {})

export function parseBoundedSmartWorkspaceLinearIssueInput(
  value: string
): ParsedLinearIssueInput | null {
  if (!isSmartWorkspaceSourceQueryWithinLimit(value)) {
    return null
  }
  const parsed = parseLinearIssueInput(value)
  if (!parsed?.organizationUrlKey) {
    return parsed
  }
  return parseLinearIssueUrlIntent(value)
}

export function parseBoundedSmartWorkspaceLinearIssueUrlIntent(
  value: string
): LinearIssueUrlIntent | null {
  return isSmartWorkspaceSourceQueryWithinLimit(value) ? parseLinearIssueUrlIntent(value) : null
}

export function getSmartWorkspaceLinearSearchQuery(value: string): string {
  const trimmed = value.trim()
  return parseBoundedSmartWorkspaceLinearIssueInput(trimmed)?.identifier ?? trimmed
}

export function isSmartWorkspaceLinearIssueIntentMatch(
  intent: ParsedLinearIssueInput,
  issue: Pick<LinearIssue, 'identifier' | 'url'>
): boolean {
  if (issue.identifier.toUpperCase() !== intent.identifier.toUpperCase()) {
    return false
  }
  if (!intent.organizationUrlKey) {
    return true
  }
  const issueInput = parseLinearIssueUrlIntent(issue.url)
  return issueInput?.organizationUrlKey?.toLowerCase() === intent.organizationUrlKey.toLowerCase()
}

export function prioritizeSmartWorkspaceLinearIssueResults(
  value: string,
  issues: readonly LinearIssue[]
): LinearIssue[] {
  const intent = parseBoundedSmartWorkspaceLinearIssueInput(value)
  if (!intent) {
    return issues.slice()
  }
  return [
    ...issues.filter((issue) => isSmartWorkspaceLinearIssueIntentMatch(intent, issue)),
    ...issues.filter((issue) => !isSmartWorkspaceLinearIssueIntentMatch(intent, issue))
  ]
}

export function isBlockingLinearUrlIntent(mode: SmartWorkspaceLinearMode, value: string): boolean {
  if (mode !== 'smart' && mode !== 'linear') {
    return false
  }
  return parseBoundedSmartWorkspaceLinearIssueUrlIntent(value) !== null
}
