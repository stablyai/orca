import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/types'

export type AgentStartupPlan = {
  /** Why: surfaces the agent id so downstream paste-draft logic can resolve
   * the per-agent draft injection strategy without re-deriving from the
   * launch command string. */
  agent: TuiAgent
  launchCommand: string
  expectedProcess: string
  followupPrompt: string | null
  /** Why: text to type into the live agent input WITHOUT submitting it (no
   * trailing \r). Used by the quick-create flow to pre-fill a linked work
   * item URL so the user can edit/add to it before sending. Independent from
   * `followupPrompt` so the call site can choose: type-and-submit (followup)
   * or type-and-leave-pending (draft). */
  draftPrompt?: string | null
  /** Why: env vars to apply at PTY spawn time. Currently used to deliver
   * pi's `ORCA_PI_PREFILL` so the overlay's `orca-prefill` extension
   * picks it up on session_start. Plumbed into `startup.env` by the
   * activation site, NOT into the shell command, so the value isn't
   * visibly prefixed onto the terminal. */
  env?: Record<string, string>
}

function isPowerShellLike(shell: string | undefined): boolean {
  if (!shell) {
    return false
  }
  const normalized = shell.toLowerCase().replace(/\\/g, '/').split('/').pop() ?? ''
  return normalized === 'powershell.exe' || normalized === 'pwsh.exe' || normalized === 'pwsh'
}

function quoteStartupArg(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `"${value.replace(/"/g, '""')}"`
  }

  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildAgentStartupPlan(args: {
  agent: TuiAgent
  prompt: string
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  allowEmptyPromptLaunch?: boolean
}): AgentStartupPlan | null {
  const { agent, prompt, cmdOverrides, platform, allowEmptyPromptLaunch = false } = args
  const trimmedPrompt = prompt.trim()
  const config = TUI_AGENT_CONFIG[agent]
  const baseCommand = cmdOverrides[agent] ?? config.launchCmd

  if (!trimmedPrompt) {
    if (!allowEmptyPromptLaunch) {
      return null
    }
    return {
      agent,
      launchCommand: baseCommand,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  const quotedPrompt = quoteStartupArg(trimmedPrompt, platform)

  if (config.promptInjectionMode === 'argv') {
    return {
      agent,
      launchCommand: `${baseCommand} ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  if (config.promptInjectionMode === 'flag-prompt') {
    return {
      agent,
      launchCommand: `${baseCommand} --prompt ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  if (config.promptInjectionMode === 'flag-prompt-interactive') {
    return {
      agent,
      launchCommand: `${baseCommand} --prompt-interactive ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  if (config.promptInjectionMode === 'flag-interactive') {
    return {
      agent,
      launchCommand: `${baseCommand} -i ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  return {
    agent,
    launchCommand: baseCommand,
    expectedProcess: config.expectedProcess,
    // Why: several agent TUIs either lack a documented "start interactive
    // session with this prompt" flag or vary too much across versions. For
    // those agents Orca launches the TUI first, then types the composed prompt
    // into the live session once the agent owns the terminal.
    followupPrompt: trimmedPrompt
  }
}

export type AgentDraftLaunchPlan = {
  agent: TuiAgent
  launchCommand: string
  expectedProcess: string
  /** Why: env-var-based prefill (currently pi via the overlay-installed
   * `orca-prefill` extension) ships the draft text in the PTY-spawn
   * environment instead of via a CLI flag. Callers MUST plumb this into
   * the queued `startup.env` so it reaches the shell that launches the
   * agent. Empty/undefined when the agent uses a CLI flag (Claude). */
  env?: Record<string, string>
}

/**
 * Why: when the agent's CLI exposes a documented "prefill but don't submit"
 * flag (currently only `claude --prefill <text>`), launch with that flag so
 * the TUI mounts with the draft already in its input box. This is strictly
 * better than the post-launch bracketed-paste fallback in agent-paste-draft.ts
 * because it eliminates the empirical readiness wait entirely — the agent
 * controls when its input is rendered.
 *
 * Returns `null` when the agent has no native prefill flag; callers fall
 * back to the paste-after-ready path.
 */
export function buildAgentDraftLaunchPlan(args: {
  agent: TuiAgent
  draft: string
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  /** Why: the post-exit clear-var command differs per Windows shell. cmd.exe
   *  uses `set "FOO="`, but PowerShell parses that as the `Set-Variable`
   *  alias and never clears the env var — so re-running the agent re-prefills
   *  with the stale URL. Callers on Windows pass the configured shell
   *  (`terminalWindowsShell`) so we can emit `Remove-Item Env:FOO` for
   *  PowerShell/pwsh. POSIX platforms ignore this. */
  windowsShell?: string
}): AgentDraftLaunchPlan | null {
  const { agent, draft, cmdOverrides, platform, windowsShell } = args
  const config = TUI_AGENT_CONFIG[agent]
  const trimmed = draft.trim()
  if (!trimmed) {
    return null
  }
  const baseCommand = cmdOverrides[agent] ?? config.launchCmd
  if (config.draftPromptFlag) {
    const quoted = quoteStartupArg(trimmed, platform)
    return {
      agent,
      launchCommand: `${baseCommand} ${config.draftPromptFlag} ${quoted}`,
      expectedProcess: config.expectedProcess
    }
  }
  if (config.draftPromptEnvVar) {
    // Why: the env var is set on the PTY-spawn env (not embedded in the
    // shell command) so the value never has to be shell-escaped and the
    // user doesn't see a `FOO='...'` prefix typed into their terminal.
    // Append a clear-var command so the var is unset from the shell env
    // once the agent exits — otherwise re-running the agent in the same
    // terminal would inherit the stale value and re-prefill with the old URL.
    const clearVar =
      platform === 'win32'
        ? isPowerShellLike(windowsShell)
          ? `Remove-Item Env:${config.draftPromptEnvVar} -ErrorAction SilentlyContinue`
          : `set "${config.draftPromptEnvVar}="`
        : `unset ${config.draftPromptEnvVar}`
    return {
      agent,
      launchCommand: `${baseCommand}; ${clearVar}`,
      expectedProcess: config.expectedProcess,
      env: { [config.draftPromptEnvVar]: trimmed }
    }
  }
  return null
}

export { isShellProcess } from '../../../shared/agent-detection'
