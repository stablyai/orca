/** The host started a terminal at the workspace root because the folder it asked for is gone. */
export type StartupCwdFallback = { kind: 'worktree'; cwd: string }

// Why no path: saved cwds can contain private repo/user names; the terminal itself shows where it opened.
export const STARTUP_CWD_FALLBACK_SENTENCE =
  'Orca opened this terminal at the workspace root because its saved start folder no longer exists.'

export const STARTUP_CWD_FALLBACK_NOTICE = `\r\n[${STARTUP_CWD_FALLBACK_SENTENCE}]\r\n`
