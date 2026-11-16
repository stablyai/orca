const ENTERPRISE_REFUSAL =
  'You cannot use --strict-mcp-config when an enterprise MCP config is present'
// Commander's refusal on every CLI that runs Orca's other flags but predates `dontAsk` (1.0.69-2.0.42).
const TOOL_POLICY_REFUSAL = "argument 'dontAsk' is invalid"

/** Built-in tools text generation may call: prompts carry their context, but saved templates may name repo files to read. */
export const CLAUDE_TEXT_GENERATION_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob']

// Every built-in tool name in CLIs 1.0.69-2.0.42, which need the legacy syntax; fixed, since they no longer change.
const LEGACY_CLAUDE_BUILTIN_TOOLS = [
  'Task',
  'Bash',
  'Glob',
  'Grep',
  'LS',
  'ExitPlanMode',
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'TodoWrite',
  'WebSearch',
  'BashOutput',
  'KillBash',
  'KillShell',
  'SlashCommand',
  'Skill',
  'AskUserQuestion',
  'LSP',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool'
]

/** Background policy is generated separately from user arguments. */
export function claudeBackgroundArgs(strictMcp = true, userArgs: readonly string[] = []): string[] {
  // A literal option value also preserves existing hooks; never interpret user argument grammar.
  const hasSettings = userArgs.some((arg) => arg === '--settings' || arg.startsWith('--settings='))
  return [
    ...(strictMcp ? ['--strict-mcp-config'] : []),
    ...(hasSettings ? [] : ['--settings', '{"disableAllHooks":true}'])
  ]
}

/** Tool policy for text generation; never plan mode, which runs another model for `haiku` and `opusplan`. */
export function claudeTextGenerationToolArgs(attempt: {
  strictMcp?: boolean
  legacyToolPolicy?: boolean
  /** No tools at all, for a prompt that is the user's own words. */
  toolFree?: boolean
}): string[] {
  const tools = attempt.toolFree ? [] : CLAUDE_TEXT_GENERATION_TOOLS
  // Explicit modes outrank a settings defaultMode of plan; the variadic tool lists stay before it.
  if (attempt.legacyToolPolicy) {
    // Older CLIs drop bare-name denied built-ins from the catalog, leaving the same tools. Their
    // plan mode never refused allowed MCP tools and their matcher has no `mcp__*`, so nothing changes there.
    const denied = LEGACY_CLAUDE_BUILTIN_TOOLS.filter((tool) => !tools.includes(tool))
    // Root-path grants (`//` is the filesystem root; Windows paths match via their /c/... form) allow
    // reads outside the checkout; a bare grant would also override a user's path-specific ask rule there.
    const granted = tools.map((tool) => `${tool}(//**)`)
    return [
      '--disallowedTools',
      denied.join(','),
      ...(granted.length > 0 ? ['--allowedTools', granted.join(',')] : []),
      '--permission-mode',
      'default'
    ]
  }
  return [
    '--tools',
    tools.join(','),
    // dontAsk refuses reads outside the checkout unless the tools are also granted.
    ...(tools.length > 0 ? ['--allowedTools', tools.join(',')] : []),
    // Without strict MCP, managed servers load; deny their tools so this attempt matches the strict one.
    ...(attempt.strictMcp === false ? ['--disallowedTools', 'mcp__*'] : []),
    '--permission-mode',
    'dontAsk'
  ]
}

export type ClaudeBackgroundFailedExit = { exitCode: number | null; stdout: string; stderr: string }

function isCompletedRefusal(
  failure: ClaudeBackgroundFailedExit | undefined,
  output: (failure: ClaudeBackgroundFailedExit) => string,
  refusals: readonly string[]
): boolean {
  return (
    !!failure &&
    typeof failure.exitCode === 'number' &&
    failure.exitCode !== 0 &&
    refusals.some((refusal) => output(failure).includes(refusal))
  )
}

function isEnterpriseRefusal(failure: ClaudeBackgroundFailedExit | undefined): boolean {
  return isCompletedRefusal(failure, (f) => `${f.stdout}\n${f.stderr}`, [ENTERPRISE_REFUSAL])
}

/** Rebuild once without generated strict mode, only after Claude's completed enterprise-policy refusal. */
export async function runClaudeBackgroundAttempts<T>(input: {
  agentId: string
  run: (strictMcp: boolean) => Promise<T>
  failedExit: (result: T) => ClaudeBackgroundFailedExit | undefined
}): Promise<T> {
  const result = await input.run(true)
  if (input.agentId !== 'claude' || !isEnterpriseRefusal(input.failedExit(result))) {
    return result
  }
  return input.run(false)
}

export type ClaudeGenerationAttempt = { strictMcp: boolean; legacyToolPolicy: boolean }

/** Text generation also steps down once to legacy tool syntax; both steps are one-way, so either survives the other. */
export async function runClaudeGenerationAttempts<T>(input: {
  agentId: string
  run: (attempt: ClaudeGenerationAttempt) => Promise<T>
  failedExit: (result: T) => ClaudeBackgroundFailedExit | undefined
}): Promise<T> {
  let attempt: ClaudeGenerationAttempt = { strictMcp: true, legacyToolPolicy: false }
  for (;;) {
    const result = await input.run(attempt)
    const failure = input.agentId === 'claude' ? input.failedExit(result) : undefined
    if (attempt.strictMcp && isEnterpriseRefusal(failure)) {
      attempt = { ...attempt, strictMcp: false }
    } else if (
      !attempt.legacyToolPolicy &&
      // Only CLIs lacking the generated mode print this; a user's own copy then fails the legacy attempt.
      isCompletedRefusal(failure, (f) => f.stderr, [TOOL_POLICY_REFUSAL])
    ) {
      attempt = { ...attempt, legacyToolPolicy: true }
    } else {
      return result
    }
  }
}
