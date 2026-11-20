export type IssueKind = 'bug' | 'feature' | 'other'

export type TriageInput = {
  title: string
  body?: string | null
  labels?: readonly string[] | null
}

export type TriageResult = {
  kind: IssueKind
  needsApproval: boolean
}

const BUG_LABELS = new Set(['bug', 'defect', 'fix', 'hotfix', 'regression', 'crash'])
const FEATURE_LABELS = new Set(['feature', 'enhancement', 'proposal', 'rfc', 'epic'])

const BUG_HINTS = [
  'fix',
  'bug',
  'crash',
  'broken',
  'regression',
  'fails',
  'failure',
  'exception',
  'stacktrace',
  'panic',
  '修复',
  '崩溃',
  '异常',
  '报错'
]

const FEATURE_HINTS = [
  'feature',
  'proposal',
  'rfc',
  'support',
  'add support',
  'please add',
  '新增',
  '新功能',
  '需求',
  '建议'
]

function haystack(input: TriageInput): string {
  return `${input.title}\n${input.body ?? ''}`.toLowerCase()
}

function labelHit(labels: readonly string[] | null | undefined, table: Set<string>): boolean {
  if (!labels) {
    return false
  }
  return labels.some((label) => table.has(label.trim().toLowerCase()))
}

function textHit(text: string, hints: readonly string[]): boolean {
  return hints.some((hint) => text.includes(hint.toLowerCase()))
}

export function triageIssue(input: TriageInput): TriageResult {
  if (labelHit(input.labels, BUG_LABELS)) {
    return { kind: 'bug', needsApproval: false }
  }
  if (labelHit(input.labels, FEATURE_LABELS)) {
    return { kind: 'feature', needsApproval: true }
  }
  const text = haystack(input)
  if (textHit(text, BUG_HINTS) && !textHit(text, FEATURE_HINTS)) {
    return { kind: 'bug', needsApproval: false }
  }
  if (textHit(text, FEATURE_HINTS)) {
    return { kind: 'feature', needsApproval: true }
  }
  return { kind: 'other', needsApproval: true }
}
