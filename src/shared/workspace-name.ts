import {
  collectCompactWorkspaceWords,
  foldWorkspaceNameWhitespaceToHyphen
} from './workspace-name-text-scanner'
import { escapeRegex } from './string-utils'
import type { JiraIssueKeyCasing } from './ui-chrome-types'
import { JIRA_ISSUE_KEY_PATTERN } from './jira/jira-issue-url'

function normalizeApostrophes(input: string): string {
  return input.replace(/[\u2018\u2019]/g, "'")
}

// Keep contractions/possessives from creating stray t/s words or branch segments.
function removeIntraWordApostrophes(input: string): string {
  return normalizeApostrophes(input).replace(/([\p{L}\p{N}])'(?=[\p{L}\p{N}])/gu, '$1')
}

function stripDanglingDisplayApostrophes(input: string): string {
  return normalizeApostrophes(input)
    .replace(/(^|[^\p{L}\p{N}])'(?=[\p{L}\p{N}])/gu, '$1')
    .replace(/([\p{L}\p{N}])'(?=$|[^\p{L}\p{N}])/gu, '$1')
}

export function slugifyForWorkspaceName(input: string): string {
  const normalized = removeIntraWordApostrophes(input)
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
  return (
    foldWorkspaceNameWhitespaceToHyphen(normalized)
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      // Match main’s sanitizer: git check-ref-format rejects repeated dots.
      .replace(/\.{2,}/g, '.')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 48)
      .replace(/[-._]+$/g, '')
  )
}

export function getLinkedWorkItemSuggestedName(item: { title: string }): string {
  const seed = getLinkedWorkItemTitleSubject(item) || item.title.trim()
  return slugifyForWorkspaceName(seed)
}

export type WorkspaceIntentWorkItem = {
  type: 'issue' | 'pr' | 'mr'
  number: number
  title: string
  provider?: 'github' | 'gitlab' | 'linear' | 'jira'
  linearIdentifier?: string
  jiraIdentifier?: string
}

export type WorkspaceIntentName = {
  displayName: string
  seedName: string
}

export type WorkspaceSeedNameOptions = {
  jiraIssueKeyCasing?: JiraIssueKeyCasing
}

// Restore casing only for the leading Jira key in generated seeds.
export function applyJiraIssueKeyCasing(
  seedName: string,
  jiraIdentifier: string | undefined,
  casing: JiraIssueKeyCasing | undefined
): string {
  const key = jiraIdentifier?.trim().toUpperCase()
  if (casing !== 'preserve' || !key || !JIRA_ISSUE_KEY_PATTERN.test(key)) {
    return seedName
  }
  // Slugification preserves key characters, so restoring leading-key casing is lossless.
  const lowerKey = key.toLowerCase()
  return seedName === lowerKey || seedName.startsWith(`${lowerKey}-`)
    ? `${key}${seedName.slice(key.length)}`
    : seedName
}

function getLinkedWorkItemTitleSubject(item: { title: string }): string {
  return item.title
    .trim()
    .replace(/^(?:issue|pr|pull request|mr|merge request)\s*[#!]?\d+\s*[:-]\s*/i, '')
    .replace(/^#\d+\s*[:-]\s*/, '')
    .replace(/\([#!]?\d+\)/g, '')
    .replace(/\b#\d+\b/g, '')
    .trim()
}

// Hyphenated generated seeds such as issue-123-fix-title do not express a new fix request.
const ACTION_LABELS: [RegExp, string][] = [
  [/(?:^|[^a-z0-9_-])(?:fix(?:e[sd])?|resolve|repair)(?:$|[^a-z0-9_-])/i, 'Fix'],
  [/(?:^|[^a-z0-9_-])(?:debug|diagnose)(?:$|[^a-z0-9_-])/i, 'Debug'],
  [/(?:^|[^a-z0-9_-])(?:review|look\s+over|inspect|check|safe|safety)(?:$|[^a-z0-9_-])/i, 'Review'],
  [/(?:^|[^a-z0-9_-])(?:implement|build|ship)(?:$|[^a-z0-9_-])/i, 'Implement'],
  [/(?:^|[^a-z0-9_-])(?:investigate|understand|triage)(?:$|[^a-z0-9_-])/i, 'Investigate'],
  [/(?:^|[^a-z0-9_-])(?:add|create)(?:$|[^a-z0-9_-])/i, 'Add'],
  [/(?:^|[^a-z0-9_-])(?:update|change)(?:$|[^a-z0-9_-])/i, 'Update'],
  [/(?:^|[^a-z0-9_-])(?:refactor|simplify)(?:$|[^a-z0-9_-])/i, 'Refactor'],
  [/(?:^|[^a-z0-9_-])(?:test|verify|validate)(?:$|[^a-z0-9_-])/i, 'Test']
]

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'with'
])

function detectIntentAction(sourceText: string): string | null {
  for (const [pattern, label] of ACTION_LABELS) {
    if (pattern.test(sourceText)) {
      return label
    }
  }
  return null
}

function titleCaseWord(word: string): string {
  const normalized = normalizeApostrophes(word)
  if (/^[A-Z]{2,}\d*$/.test(normalized) || /^[A-Z]+-\d+$/i.test(normalized)) {
    return normalized.toUpperCase()
  }
  const acronymPossessive = normalized.match(/^([A-Z]{2,}\d*)'([sS])$/)
  if (acronymPossessive) {
    return `${acronymPossessive[1].toUpperCase()}'s`
  }
  const lower = normalized.toLowerCase()
  const apostropheParts = lower.split("'")
  if (apostropheParts.length === 2 && apostropheParts[0].length === 1 && apostropheParts[1]) {
    return `${apostropheParts[0].toUpperCase()}'${apostropheParts[1]}`
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function compactWords(input: string, maxWords = 4): string {
  // Bound word collection for names derived from pasted prompts or URLs.
  const words = collectCompactWorkspaceWords(
    stripDanglingDisplayApostrophes(input),
    maxWords,
    STOP_WORDS
  )
  return words.map(titleCaseWord).join(' ')
}

function compactWorkItemTitle(title: string, item: WorkspaceIntentWorkItem): string {
  const identifier = item.linearIdentifier ?? item.jiraIdentifier
  let withoutPrefix = title
    .trim()
    .replace(/^(?:issue|pr|pull request|mr|merge request)\s*[#!]?\d+\s*[:-]\s*/i, '')
    .replace(/\([#!]?\d+\)/g, '')
    .replace(/^[^:]{1,32}:\s*/, '')
    .trim()
  if (item.number > 0) {
    withoutPrefix = withoutPrefix.replace(new RegExp(`\\b[#!]?${item.number}\\b`, 'g'), '').trim()
  }
  if (identifier) {
    withoutPrefix = withoutPrefix
      .replace(new RegExp(`^${escapeRegex(identifier)}\\s*[:-]?\\s*`, 'i'), '')
      .trim()
  }
  return compactWords(withoutPrefix || title, 3)
}

function workItemIdentity(item: WorkspaceIntentWorkItem): string {
  if (item.linearIdentifier) {
    return item.linearIdentifier.toUpperCase()
  }
  if (item.jiraIdentifier) {
    return item.jiraIdentifier.toUpperCase()
  }
  if (item.type === 'pr') {
    return `PR ${item.number}`
  }
  if (item.type === 'mr') {
    return `MR ${item.number}`
  }
  return `Issue ${item.number}`
}

export function getLinkedWorkItemWorkspaceName(
  item: WorkspaceIntentWorkItem,
  options: WorkspaceSeedNameOptions = {}
): WorkspaceIntentName | null {
  const identifier = item.linearIdentifier ?? item.jiraIdentifier
  let subject = getLinkedWorkItemTitleSubject(item) || item.title.trim()
  if (identifier) {
    subject = subject
      .replace(new RegExp(`^${escapeRegex(identifier)}\\s*[:-]?\\s*`, 'i'), '')
      .trim()
  }
  const displayName = [identifier, subject].filter(Boolean).join(' ') || workItemIdentity(item)
  const seedName = applyJiraIssueKeyCasing(
    slugifyForWorkspaceName(displayName),
    item.provider === 'jira' || (!item.provider && !item.linearIdentifier)
      ? item.jiraIdentifier
      : undefined,
    options.jiraIssueKeyCasing
  )
  if (!seedName) {
    return null
  }
  return { displayName, seedName }
}

function defaultActionForWorkItem(item: WorkspaceIntentWorkItem): string | null {
  return item.type === 'pr' || item.type === 'mr' ? 'Review' : null
}

/** Derive display label and branch-safe seed from one first-create intent so folder, branch and sidebar names agree. */
export function getWorkspaceIntentName(args: {
  sourceText?: string
  workItem?: WorkspaceIntentWorkItem | null
  fallbackName?: string
}): WorkspaceIntentName | null {
  const sourceText = args.sourceText?.trim() ?? ''
  const item = args.workItem ?? null
  let displayName = ''

  if (item) {
    const action = detectIntentAction(sourceText) ?? defaultActionForWorkItem(item)
    const identity = workItemIdentity(item)
    if (action) {
      displayName = `${action} ${identity}`
    } else {
      const subject = compactWorkItemTitle(item.title, item)
      displayName = [identity, subject].filter(Boolean).join(' ')
    }
  } else if (sourceText) {
    const compact = compactWords(sourceText, 5)
    displayName = compact
  }

  if (!displayName && args.fallbackName?.trim()) {
    displayName = args.fallbackName.trim()
  }
  if (!displayName) {
    return null
  }

  const seedName = slugifyForWorkspaceName(displayName)
  if (!seedName) {
    return null
  }
  return { displayName, seedName }
}

export function getLinearIssueWorkspaceName(issue: { identifier: string; title: string }): string {
  const key = slugifyForWorkspaceName(issue.identifier)
  const titleSlug = getLinkedWorkItemSuggestedName(issue)
  if (!key) {
    return titleSlug
  }
  let dedupedTitleSlug = titleSlug
  if (titleSlug === key) {
    dedupedTitleSlug = ''
  } else if (titleSlug.startsWith(`${key}-`)) {
    dedupedTitleSlug = titleSlug.slice(key.length + 1)
  }
  return slugifyForWorkspaceName([key, dedupedTitleSlug].filter(Boolean).join('-'))
}

export function resolveWorkspaceCreateName(args: {
  draft: string | undefined
  fallback: string
}): string {
  return args.draft?.trim() || args.fallback
}
