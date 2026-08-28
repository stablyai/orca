import type { AiVaultListResult, AiVaultScanIssue } from '../../../../shared/ai-vault-types'

export function blockingAiVaultScanIssue(
  result: AiVaultListResult | null
): AiVaultScanIssue | null {
  if (!result || result.sessions.length > 0) {
    return null
  }
  return result.issues.find((issue) => issue.kind === 'host') ?? null
}

// Host and scope issues carry their own scanner-authored copy, so they get their
// own rows instead of being counted as skipped transcripts — a partial scan
// (one SSH host down, rest fine) must not report a connectivity failure as a
// skipped transcript file, and an unreadable *source* (a whole locked
// opencode.db holding every OpenCode session) must not read as "1 transcript
// skipped".
export function aiVaultScanNoticeIssues(result: AiVaultListResult | null): AiVaultScanIssue[] {
  if (!result) {
    return []
  }
  const blocking = blockingAiVaultScanIssue(result)
  return result.issues.filter((issue) => Boolean(issue.kind) && issue !== blocking)
}

export function skippedAiVaultTranscriptCount(result: AiVaultListResult | null): number {
  return result ? result.issues.filter((issue) => !issue.kind).length : 0
}

const SKIPPED_TRANSCRIPT_REASON_LIMIT = 3

// Why: a bare "3 transcripts skipped" hides the actionable part (a 10 MiB cap
// hit, an unreadable transcript). Surface the distinct scanner-authored reasons,
// capped so a 500-issue scan can't turn the panel into a wall of text.
export function skippedAiVaultTranscriptReasons(result: AiVaultListResult | null): string[] {
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
