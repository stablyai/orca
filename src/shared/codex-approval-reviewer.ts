export type CodexApprovalReviewer = 'auto_review' | 'user' | 'unknown'
export type ExplicitCodexApprovalReviewer = Exclude<CodexApprovalReviewer, 'unknown'>
export const ORCA_CODEX_APPROVAL_REVIEWER_ENV = 'ORCA_CODEX_APPROVAL_REVIEWER' as const

export function parseExplicitCodexApprovalReviewer(
  value: unknown
): ExplicitCodexApprovalReviewer | undefined {
  return value === 'auto_review' || value === 'user' ? value : undefined
}

export function resolveCodexApprovalReviewer(
  agentArgs: string | null | undefined
): CodexApprovalReviewer {
  let reviewer: CodexApprovalReviewer = 'unknown'
  for (const match of (agentArgs ?? '').matchAll(
    /\bapprovals_reviewer\s*=\s*(?:\\?["'])?(auto_review|guardian_subagent|user)\b/gi
  )) {
    reviewer = match[1]?.toLowerCase() === 'user' ? 'user' : 'auto_review'
  }
  return reviewer
}
