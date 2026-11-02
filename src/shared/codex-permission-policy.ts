import type { AgentChatPermissionMode } from './agent-chat-permission-mode'
import type { CodexApprovalsReviewer } from './codex-subagent-reviewer'

export type CodexStructuredPermissionPolicy =
  | {
      approvalPolicy: 'never'
      sandbox: 'danger-full-access'
      approvalsReviewer: CodexApprovalsReviewer
    }
  | {
      approvalPolicy: 'on-request'
      sandbox: 'workspace-write'
      approvalsReviewer: CodexApprovalsReviewer
    }
  | {
      approvalPolicy: 'on-request'
      sandbox: 'read-only'
      approvalsReviewer: CodexApprovalsReviewer
    }

const FULL_ACCESS_POLICY = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  approvalsReviewer: 'user'
} as const

// Explicit fields prevent inheriting permissive config or previous thread policies.
/** Workspace writes need approval even when the user's configured sandbox permits them. */
const ASK_POLICY = {
  approvalPolicy: 'on-request',
  sandbox: 'read-only',
  approvalsReviewer: 'user'
} as const

// A mode preserves configured roots/network; read-only would add write approvals.
const AUTO_POLICY = {
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write',
  approvalsReviewer: 'auto_review'
} as const

/** Codex has no edits-only mode; unsupported modes fall back to Ask. */
export function codexStructuredPermissionPolicy(
  mode: AgentChatPermissionMode
): CodexStructuredPermissionPolicy {
  return mode === 'full-access' ? FULL_ACCESS_POLICY : mode === 'auto' ? AUTO_POLICY : ASK_POLICY
}

/**
 * Ask for a Codex terminal, as the CLI's own flags. Intended difference from chat Ask: the
 * interactive CLI offers only `on-request` and `never` approvals (no `untrusted`), so a read-only
 * sandbox is what makes it ask before every edit, while commands follow `on-request`. Every field
 * is stated, as for chats, so the user's own `config.toml` cannot turn it into no prompts.
 */
export const CODEX_TERMINAL_ASK_ARGS: readonly string[] = [
  '-a',
  'on-request',
  '-s',
  'read-only',
  '-c',
  'approvals_reviewer="user"'
]
