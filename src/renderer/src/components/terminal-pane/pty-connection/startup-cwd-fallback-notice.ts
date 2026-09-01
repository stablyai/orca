// Why: the notice deliberately omits the rejected path — saved cwds can
// contain private repo/user names; the terminal itself shows where it opened.
export const STARTUP_CWD_FALLBACK_NOTICE =
  '\r\n[Orca opened this terminal at the workspace root because its saved start folder no longer exists.]\r\n'
