export type CodexApprovalReviewer = 'auto_review' | 'user' | 'unknown'
export type ExplicitCodexApprovalReviewer = Exclude<CodexApprovalReviewer, 'unknown'>
export const ORCA_CODEX_APPROVAL_REVIEWER_ENV = 'ORCA_CODEX_APPROVAL_REVIEWER' as const

export function parseExplicitCodexApprovalReviewer(
  value: unknown
): ExplicitCodexApprovalReviewer | undefined {
  return value === 'auto_review' || value === 'user' ? value : undefined
}

/**
 * Resolve who owns Codex permission pauses from launch argv.
 * Why: PermissionRequest fires before auto-review decides (#13600/#8387); launch
 * ownership is the durable signal until Codex exposes a per-request reviewer.
 */
export function resolveCodexApprovalReviewer(
  agentArgs: string | null | undefined
): CodexApprovalReviewer {
  const args = agentArgs ?? ''
  let reviewer: CodexApprovalReviewer = 'unknown'

  // Why: Orca Auto preset and vendor CLI flag both mean "Approve for me" (quoted or bare).
  if (/(?:^|[\s'"])--approve-for-me(?:[\s'"]|$)/.test(args)) {
    reviewer = 'auto_review'
  }

  for (const match of args.matchAll(
    /\bapprovals_reviewer\s*=\s*(?:\\?["'])?(auto_review|guardian_subagent|user)\b/gi
  )) {
    reviewer = match[1]?.toLowerCase() === 'user' ? 'user' : 'auto_review'
  }
  return reviewer
}
