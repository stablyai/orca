// Startup-plan assembly from a host-resolved launch. Consumes ResolvedAgentLaunch
// policy instead of re-indexing TUI_AGENT_CONFIG or re-reading settings: the
// resolver already produced the complete structured argv, so this step only
// appends the prompt per the resolved injection mode and quotes each final argv
// element exactly once for the target shell. Draft delivery lands the prompt
// UNSUBMITTED via the resolved policy's native flag/env, or hands it back as
// draftPrompt for the readiness writer to paste. No caller may reparse,
// interpolate, or concatenate the result.

import type { ResolvedAgentLaunch } from './agent-launch-host-contract'
import type { AgentStartupPlan } from './tui-agent-startup'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import {
  buildShellCommandFromArgv,
  clearEnvCommand,
  CMD_UNENCODABLE_CHAR_RE,
  commandSeparator,
  resolveStartupShell,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import { startupArgvExceedsShellLimit } from './agent-startup-command-limit'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { planHermesStartupQueryFromArgv } from './hermes-startup-query'
import { inlineAgentDraftFitsPlatform } from './agent-draft-platform-limit'

export type ResolvedAgentStartupPlanArgs = {
  launch: ResolvedAgentLaunch
  prompt: string
  allowEmptyPromptLaunch?: boolean
  launchToken?: string
  /** 'draft' lands the prompt UNSUBMITTED; default 'submit'. */
  promptDelivery?: 'submit' | 'draft'
  /** Inline draft-flag command ceiling; over it the draft falls back to
   *  post-ready paste (draftPrompt) rather than dropping the text. Main threads
   *  STARTUP_COMMAND_TEXT_MAX_CHARS; absent means no ceiling. */
  maxInlineDraftChars?: number
}

/** Where the prompt lands: appended argv, a trailing command clause (draft
 *  env-var cleanup), spawn-only env, the post-ready followup/draft text, and any
 *  delivery override. draftPrompt is set only when the readiness writer paste is
 *  the delivery mechanism. */
type PromptParts = {
  argvSuffix: string[]
  commandSuffix: string
  extraEnv: Record<string, string>
  followupPrompt: string | null
  draftPrompt: string | null
  startupCommandDelivery: StartupCommandDelivery | undefined
}

const NO_PROMPT: PromptParts = {
  argvSuffix: [],
  commandSuffix: '',
  extraEnv: {},
  followupPrompt: null,
  draftPrompt: null,
  startupCommandDelivery: undefined
}

function submitParts(launch: ResolvedAgentLaunch, trimmedPrompt: string): PromptParts {
  const mode = launch.policy.promptInjectionMode
  if (mode === 'argv') {
    const separator = TUI_AGENT_CONFIG[launch.baseAgent].argvPromptSeparator
    return {
      ...NO_PROMPT,
      argvSuffix: separator ? [separator, trimmedPrompt] : [trimmedPrompt],
      // Why: codex consumes an argv prompt only after its shell integration is
      // ready; matches the legacy plan's delivery selection for the same case.
      startupCommandDelivery: launch.baseAgent === 'codex' ? ('shell-ready' as const) : undefined
    }
  }
  if (mode === 'flag-prompt') {
    return { ...NO_PROMPT, argvSuffix: ['--prompt', trimmedPrompt] }
  }
  if (mode === 'flag-prompt-interactive') {
    return { ...NO_PROMPT, argvSuffix: ['--prompt-interactive', trimmedPrompt] }
  }
  if (mode === 'flag-interactive') {
    return { ...NO_PROMPT, argvSuffix: ['-i', trimmedPrompt] }
  }
  // stdin-after-start: bare TUI launch; the readiness writer delivers the prompt.
  return { ...NO_PROMPT, followupPrompt: trimmedPrompt }
}

function draftParts(
  launch: ResolvedAgentLaunch,
  trimmedPrompt: string,
  shell: AgentStartupShell,
  maxInlineDraftChars: number
): PromptParts {
  const { draftPromptFlag, draftPromptEnvVar } = launch.policy
  if (draftPromptFlag) {
    const inlineArgv = [...launch.argv, draftPromptFlag, trimmedPrompt]
    if (buildShellCommandFromArgv(inlineArgv, shell).length <= maxInlineDraftChars) {
      return {
        ...NO_PROMPT,
        argvSuffix: [draftPromptFlag, trimmedPrompt],
        // Why: native draft flags carry user text on argv and must survive
        // rc-file startup, same as an argv submit prompt.
        startupCommandDelivery: launch.baseAgent === 'codex' ? ('shell-ready' as const) : undefined
      }
    }
    // Oversized inline draft: deliberately deliver via post-ready paste and
    // retain the FULL text — never null/truncated/dropped.
    return { ...NO_PROMPT, draftPrompt: trimmedPrompt }
  }
  if (draftPromptEnvVar) {
    const commandSuffix = `${commandSeparator(shell)}${clearEnvCommand(draftPromptEnvVar, shell)}`
    const fits = inlineAgentDraftFitsPlatform({
      command: `${buildShellCommandFromArgv(launch.argv, shell)}${commandSuffix}`,
      env: { ...launch.agentEnv, [draftPromptEnvVar]: trimmedPrompt },
      platform: launch.policy.platform
    })
    if (!fits) {
      // Why: Windows CreateProcess env blocks have tight ceilings; an oversized
      // draft falls back to post-ready paste with the FULL text.
      return { ...NO_PROMPT, draftPrompt: trimmedPrompt }
    }
    return {
      ...NO_PROMPT,
      // Why: clear the prefill var right after launch so the draft never leaks to
      // nested shells the agent spawns.
      commandSuffix,
      extraEnv: { [draftPromptEnvVar]: trimmedPrompt }
    }
  }
  // No native draft affordance: the readiness writer pastes it unsubmitted.
  return { ...NO_PROMPT, draftPrompt: trimmedPrompt }
}

/** Build the single startup plan for a resolved launch. The prompt (when the
 *  injection mode takes one) is appended to a disposable argv copy exactly once;
 *  the immutable snapshot argv is never extended, and the draft env var / prompt
 *  transport never enters the durable resume config's agentEnv. */
export function buildAgentStartupPlanFromResolvedLaunch(
  args: ResolvedAgentStartupPlanArgs
): AgentStartupPlan | null {
  const { launch } = args
  const shell = resolveStartupShell(launch.policy.platform, launch.snapshot.target.shell)
  const trimmedPrompt = args.prompt.trim()

  if (!trimmedPrompt && !(args.allowEmptyPromptLaunch ?? false)) {
    return null
  }

  if (
    trimmedPrompt &&
    (args.promptDelivery ?? 'submit') === 'submit' &&
    launch.policy.promptInjectionMode === 'hermes-query'
  ) {
    const queryPlan = planHermesStartupQueryFromArgv({
      argv: [...launch.argv, ...(launch.resumeArgvSuffix ?? [])],
      prompt: trimmedPrompt,
      agentEnv: { ...launch.agentEnv },
      platform: launch.policy.platform,
      shell
    })
    if (queryPlan) {
      return {
        agent: launch.requestedAgent,
        // Why: Hermes owns readiness and submission for `chat --query`; the
        // prompt travels via the startup-query env, never the paste writer.
        launchCommand: queryPlan.command,
        expectedProcess: launch.policy.expectedProcess,
        followupPrompt: null,
        launchConfig: {
          agentCommand: buildShellCommandFromArgv(launch.argv, shell),
          agentArgs: '',
          // Why: the query transport env is spawn-only; only the admitted user
          // agent env enters the durable resume config.
          agentEnv: { ...launch.agentEnv }
        },
        ...(args.launchToken ? { launchToken: args.launchToken } : {}),
        env: queryPlan.env
      }
    }
    // Unplannable query (unrecognized argv or over the env-block bound): fall
    // through to the readiness-writer paste rather than dropping the prompt.
  }

  const plannedParts = !trimmedPrompt
    ? NO_PROMPT
    : (args.promptDelivery ?? 'submit') === 'draft'
      ? draftParts(
          launch,
          trimmedPrompt,
          shell,
          args.maxInlineDraftChars ?? Number.POSITIVE_INFINITY
        )
      : submitParts(launch, trimmedPrompt)
  const offArgvParts: PromptParts = {
    ...NO_PROMPT,
    ...((args.promptDelivery ?? 'submit') === 'draft'
      ? { draftPrompt: trimmedPrompt }
      : { followupPrompt: trimmedPrompt })
  }
  // Why: the cmd quoter cannot encode % ! ^ " inside a double-quoted argv
  // element (cmd_metachar) — an embedded quote would re-split the command line.
  // Fail closed off argv and deliver the FULL prompt via the readiness writer.
  const encodableParts =
    shell === 'cmd' && plannedParts.argvSuffix.some((el) => CMD_UNENCODABLE_CHAR_RE.test(el))
      ? offArgvParts
      : plannedParts

  // The durable launch config records only the base command (no resume flags), so
  // a fresh relaunch never re-resumes a stale session; the resume flags land only
  // in the one-shot launchCommand between the base argv and any prompt suffix.
  const baseCommand = buildShellCommandFromArgv(launch.argv, shell)
  const resumeSuffix = launch.resumeArgvSuffix ?? []
  // Why: the resolver capped the resolved argv, but the prompt is appended HERE
  // and the RPC admits up to 100k chars — an argv/flag prompt can push the final
  // command past the target's hard ceiling (cmd.exe truncates at 8191), which no
  // delivery path can carry. Move the FULL prompt off argv, as above.
  // The env-var draft path adds no argv element but still appends a cleanup
  // clause, which alone can cross the ceiling on a near-full base command.
  const addsCommandText =
    encodableParts.argvSuffix.length > 0 || encodableParts.commandSuffix.length > 0
  const parts =
    addsCommandText &&
    startupArgvExceedsShellLimit(
      [...launch.argv, ...resumeSuffix, ...encodableParts.argvSuffix],
      shell,
      encodableParts.commandSuffix
    )
      ? offArgvParts
      : encodableParts
  const finalArgv = [...launch.argv, ...resumeSuffix, ...parts.argvSuffix]
  const spawnEnv = { ...launch.agentEnv, ...parts.extraEnv }
  return {
    agent: launch.requestedAgent,
    launchCommand: `${buildShellCommandFromArgv(finalArgv, shell)}${parts.commandSuffix}`,
    expectedProcess: launch.policy.expectedProcess,
    followupPrompt: parts.followupPrompt,
    launchConfig: {
      agentCommand: baseCommand,
      agentArgs: '',
      // Why: only the admitted user agent env enters the durable resume config;
      // pane identity/prompt transport env (draft env var) is spawn-only and
      // must never persist.
      agentEnv: { ...launch.agentEnv }
    },
    ...(parts.draftPrompt !== null ? { draftPrompt: parts.draftPrompt } : {}),
    ...(args.launchToken ? { launchToken: args.launchToken } : {}),
    ...(parts.startupCommandDelivery
      ? { startupCommandDelivery: parts.startupCommandDelivery }
      : {}),
    ...(Object.keys(spawnEnv).length > 0 ? { env: spawnEnv } : {})
  }
}
