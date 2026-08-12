export type CodexApprovalReviewer = 'auto_review' | 'user' | 'unknown'
export type ExplicitCodexApprovalReviewer = Exclude<CodexApprovalReviewer, 'unknown'>
export const ORCA_CODEX_APPROVAL_REVIEWER_ENV = 'ORCA_CODEX_APPROVAL_REVIEWER' as const

export function parseExplicitCodexApprovalReviewer(
  value: unknown
): ExplicitCodexApprovalReviewer | undefined {
  return value === 'auto_review' || value === 'user' ? value : undefined
}

/**
 * Resolve reviewer from launch argv only.
 * Why: wire/hook stamps are untrusted for suppression authority (#13600 audit);
 * only explicit auto_review / user count — guardian_subagent must not widen to auto_review.
 */
export function resolveCodexApprovalReviewer(
  agentArgs: string | null | undefined
): CodexApprovalReviewer {
  let reviewer: CodexApprovalReviewer = 'unknown'
  for (const match of (agentArgs ?? '').matchAll(
    /\bapprovals_reviewer\s*=\s*(?:\\?["'])?(auto_review|guardian_subagent|user)\b/gi
  )) {
    const value = match[1]?.toLowerCase()
    if (value === 'user') {
      reviewer = 'user'
    } else if (value === 'auto_review') {
      reviewer = 'auto_review'
    }
    // Why: guardian_subagent is a different reviewer; mapping it to auto_review
    // would suppress Needs-You for pauses that may still need the user.
  }
  return reviewer
}

/**
 * Authoritative ownership for attention suppression.
 * Why: launchToken-owned agentArgs are the only durable proof; wire stamps
 * (hydrate, remote inject, stale IPC) must never alone prove auto_review.
 */
export function resolveAuthoritativeCodexApprovalReviewer(args: {
  agentArgs?: string | null
  /** Untrusted wire/hook stamp — ignored for auto_review authority. */
  wireReviewer?: ExplicitCodexApprovalReviewer | null
}): CodexApprovalReviewer {
  void args.wireReviewer
  return resolveCodexApprovalReviewer(args.agentArgs)
}
