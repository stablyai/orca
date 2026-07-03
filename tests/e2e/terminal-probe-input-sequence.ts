export function buildFreshShellProbeInputSequence(command: string): readonly string[] {
  // Why: Windows ConPTY can echo a startup Ctrl+C as literal "^C", which
  // corrupts the following PowerShell command before the shell is ready.
  return [command]
}
