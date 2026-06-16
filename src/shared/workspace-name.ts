function normalizeApostrophes(input: string): string {
  return input.replace(/[‘’]/g, "'")
}

// Why: contractions and possessives should not become stray `t` / `s` tokens
// in display names or extra hyphen segments in branch-safe workspace seeds.
function removeIntraWordApostrophes(input: string): string {
  return normalizeApostrophes(input).replace(/([\p{L}\p{N}])'(?=[\p{L}\p{N}])/gu, '$1')
}

function stripDanglingDisplayApostrophes(input: string): string {
  return normalizeApostrophes(input)
    .replace(/(^|[^\p{L}\p{N}])'(?=[\p{L}\p{N}])/gu, '$1')
    .replace(/([\p{L}\p{N}])'(?=$|[^\p{L}\p{N}])/gu, '$1')
}

export function slugifyForWorkspaceName(input: string): string {
  return (
    removeIntraWordApostrophes(input)
      .trim()
      .toLowerCase()
      .replace(/[\\/]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      // Why: git check-ref-format rejects any ref containing `..`, so previews
      // must match the main-process sanitizer before workspace creation.
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

function getLinkedWorkItemTitleSubject(item: { title: string }): string {
  return item.title
    .trim()
    .replace(/^(?:issue|pr|pull request|mr|merge request)\s*[#!]?\d+\s*[:-]\s*/i, '')
    .replace(/^#\d+\s*[:-]\s*/, '')
    .replace(/\([#!]?\d+\)/g, '')
    .replace(/\b#\d+\b/g, '')
    .trim()
}

// Why: generated workspace seeds are hyphenated; `issue-123-fix-title`
// must not be reinterpreted as the user explicitly asking to fix a new issue.
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
  return stripDanglingDisplayApostrophes(input)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[()[\]{}"]/g, ' ')
    .replace(/[#/\\:_-]+/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => !STOP_WORDS.has(word.toLowerCase()))
    .slice(0, maxWords)
    .map(titleCaseWord)
    .join(' ')
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
      .replace(new RegExp(`^${escapeRegExp(identifier)}\\s*[:-]?\\s*`, 'i'), '')
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
  item: WorkspaceIntentWorkItem
): WorkspaceIntentName | null {
  const identifier = item.linearIdentifier ?? item.jiraIdentifier
  let subject = getLinkedWorkItemTitleSubject(item) || item.title.trim()
  if (identifier) {
    subject = subject
      .replace(new RegExp(`^${escapeRegExp(identifier)}\\s*[:-]?\\s*`, 'i'), '')
      .trim()
  }
  const displayName = [identifier, subject].filter(Boolean).join(' ') || workItemIdentity(item)
  const seedName = slugifyForWorkspaceName(displayName)
  if (!seedName) {
    return null
  }
  return { displayName, seedName }
}

function defaultActionForWorkItem(item: WorkspaceIntentWorkItem): string | null {
  return item.type === 'pr' || item.type === 'mr' ? 'Review' : null
}

/**
 * Resolve the one human intent label that should drive first-create workspace
 * identity. The display label and git-safe seed are derived together so the
 * folder, branch, and sidebar name do not drift before work has started.
 */
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
