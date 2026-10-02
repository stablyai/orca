import type { AiVaultScanIssue } from '../contracts/ai-vault-types'

/** Desktop and mobile History classify the same listSessions reply. */
type AiVaultScanIssueView = {
  sessions: readonly unknown[]
  issues: readonly AiVaultScanIssue[]
} | null

export function blockingAiVaultScanIssue(result: AiVaultScanIssueView): AiVaultScanIssue | null {
  if (!result || result.sessions.length > 0) {
    return null
  }
  return result.issues.find((issue) => issue.kind === 'host') ?? null
}

// Host/scope failures need their own rows: one unreachable host or locked database can hide many transcripts.
export function aiVaultScanNoticeIssues(result: AiVaultScanIssueView): AiVaultScanIssue[] {
  if (!result) {
    return []
  }
  const blocking = blockingAiVaultScanIssue(result)
  return result.issues.filter((issue) => Boolean(issue.kind) && issue !== blocking)
}

/** Only kind-less issues are individual transcripts the scan skipped. */
export function skippedAiVaultTranscriptIssues(result: AiVaultScanIssueView): AiVaultScanIssue[] {
  return result ? result.issues.filter((issue) => !issue.kind) : []
}
