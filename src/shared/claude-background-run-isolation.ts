const ENTERPRISE_REFUSAL =
  'You cannot use --strict-mcp-config when an enterprise MCP config is present'

/** Background policy is generated separately from user arguments. */
export function claudeBackgroundArgs(strictMcp = true, userArgs: readonly string[] = []): string[] {
  // A literal option value also preserves existing hooks; never interpret user argument grammar.
  const hasSettings = userArgs.some((arg) => arg === '--settings' || arg.startsWith('--settings='))
  return [
    ...(strictMcp ? ['--strict-mcp-config'] : []),
    ...(hasSettings ? [] : ['--settings', '{"disableAllHooks":true}'])
  ]
}

export type ClaudeBackgroundFailedExit = { exitCode: number | null; stdout: string; stderr: string }

/** Rebuild once without generated strict mode, only after Claude's completed enterprise-policy refusal. */
export async function runClaudeBackgroundAttempts<T>(input: {
  agentId: string
  run: (strictMcp: boolean) => Promise<T>
  failedExit: (result: T) => ClaudeBackgroundFailedExit | undefined
}): Promise<T> {
  const result = await input.run(true)
  const failure = input.failedExit(result)
  if (
    input.agentId !== 'claude' ||
    !failure ||
    typeof failure.exitCode !== 'number' ||
    failure.exitCode === 0 ||
    !`${failure.stdout}\n${failure.stderr}`.includes(ENTERPRISE_REFUSAL)
  ) {
    return result
  }
  return input.run(false)
}
