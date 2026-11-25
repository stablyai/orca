/** A Codex account restart stops one pane's process; Orca's normal resume brings it back. */
export type CodexAccountRestartStopRequest = {
  worktreeId: string
  tabId: string
  leafId: string
  /** What the renderer saw; the grant is the pane, so this only detects turnover. */
  ptyId: string
  /** Minted per click or Retry; replies carry every joined id. */
  opId: string
}

/** The in-pane failure when a stopped pane cannot resume its conversation on the new account. */
export const CODEX_ACCOUNT_RESTART_RESUME_ERROR =
  "Couldn't resume on the new account. Restart the pane to try again."

/** The pane a release or close names; it carries no operation. */
export type CodexAccountRestartPane = Pick<
  CodexAccountRestartStopRequest,
  'worktreeId' | 'tabId' | 'leafId'
>

/** Dismissing a failed resume names the stop it followed; another stop's refusal stays. */
export type CodexAccountRestartReleaseRequest = CodexAccountRestartPane & {
  opIds: readonly string[]
}

/** Dismiss for one pane and operation; a stale opId changes nothing. */
export type CodexAccountRestartWithdrawRequest = Pick<
  CodexAccountRestartStopRequest,
  'worktreeId' | 'tabId' | 'leafId' | 'opId'
>

export type CodexAccountRestartNotStartedReason =
  | 'invalid'
  | 'superseded'
  | 'not-stale'
  | 'unsupported'
  | 'no-session'
  | 'resume-unavailable'
  | 'withdrawn'
  | 'refused'
  /** A local terminal service without fenced stops: manual until Orca restarts it. */
  | 'service-outdated'

/** Every joined click's opId is listed, so one stop settles every current notice. */
export type CodexAccountRestartStopResult =
  | { outcome: 'stopped'; opIds: string[] }
  | {
      outcome: 'not-started'
      reason: CodexAccountRestartNotStartedReason
      opIds: string[]
    }
  | { outcome: 'unknown'; opIds: string[] }
