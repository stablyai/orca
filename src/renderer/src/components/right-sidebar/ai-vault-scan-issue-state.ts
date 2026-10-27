import type { AiVaultListResult, AiVaultScanIssue } from '../../../../shared/ai-vault-types'

export function blockingAiVaultScanIssue(
  result: AiVaultListResult | null
): AiVaultScanIssue | null {
  if (!result || result.sessions.length > 0) {
    return null
  }
  return result.issues.find((issue) => issue.kind === 'host') ?? null
}

// Host/scope failures need their own rows: one unreachable host or locked database can hide many transcripts.
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

// Expose distinct scanner reasons, capped so large issue sets cannot overwhelm the panel.
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
