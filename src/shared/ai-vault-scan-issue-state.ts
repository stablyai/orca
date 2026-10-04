import type { AiVaultScanIssue } from './ai-vault-types'

type AiVaultScanIssueView = {
  sessions: readonly { id: string }[]
  issues: readonly AiVaultScanIssue[]
} | null

export function blockingAiVaultScanIssue(result: AiVaultScanIssueView): AiVaultScanIssue | null {
  if (!result || result.sessions.length > 0) {
    return null
  }
  return result.issues.find((issue) => issue.kind === 'host') ?? null
}

// A host or whole source failure is not a skipped transcript file.
export function aiVaultScanNoticeIssues(result: AiVaultScanIssueView): AiVaultScanIssue[] {
  if (!result) {
    return []
  }
  const blocking = blockingAiVaultScanIssue(result)
  return result.issues.filter((issue) => Boolean(issue.kind) && issue !== blocking)
}

export function skippedAiVaultTranscriptCount(result: AiVaultScanIssueView): number {
  return result ? result.issues.filter((issue) => !issue.kind).length : 0
}

const SKIPPED_TRANSCRIPT_REASON_LIMIT = 3

// Keep actionable reasons visible without letting hundreds of issues fill the panel.
export function skippedAiVaultTranscriptReasons(result: AiVaultScanIssueView): string[] {
  const reasons = new Set<string>()
  for (const issue of result?.issues ?? []) {
    if (issue.kind) {
      continue
    }
    const message = issue.message.trim()
    if (message) {
      reasons.add(message)
    }
    if (reasons.size === SKIPPED_TRANSCRIPT_REASON_LIMIT) {
      break
    }
  }
  return [...reasons]
}
