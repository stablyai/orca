import { resolveTuiAgentLaunchArgs, resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'
import { YOLO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ENV } from './tui-agent-permissions'
import {
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'

/** Scans option position only: a sequence behind the agent's own `--` is data
 * for the child, not a permission flag. */
function containsTokenSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
  for (let index = 0; index + sequence.length <= tokens.length; index += 1) {
    if (tokens[index] === '--') {
      return false
    }
    if (sequence.every((token, offset) => tokens[index + offset] === token)) {
      return true
    }
  }
  return false
}

/** Splices every occurrence of `sequence` out of `value` by source span, so
 * bytes outside the removed tokens survive verbatim instead of being requoted.
 *
 * Fails open — returns `value` untouched — whenever the string cannot be
 * modeled for `shell`: an unparseable command, a token this tokenizer reads
 * differently than the shell will, or live syntax between tokens. */
function dropTokenSequence(
  value: string,
  sequence: readonly string[],
  shell: AgentStartupShell,
  from: number
): string {
  const tokenized = tokenizeStartupCommand(value, shell)
  if (!tokenized.ok) {
    return value
  }
  const { tokens, spans } = tokenized
  for (let index = 0; index <= tokens.length; index += 1) {
    const gapStart = index === 0 ? 0 : spans[index - 1].end
    const gapEnd = index === tokens.length ? value.length : spans[index].start
    if (!/^[ \t]*$/.test(value.slice(gapStart, gapEnd))) {
      return value
    }
    if (index < tokens.length && spans[index].divergesFromShell) {
      return value
    }
  }
  const cuts: { start: number; end: number }[] = []
  for (let index = from; index + sequence.length <= tokens.length; index += 1) {
    if (tokens[index] === '--') {
      break
    }
    if (!sequence.every((token, offset) => tokens[index + offset] === token)) {
      continue
    }
    // Why: absorb the separator ahead of the flag so removing it cannot leave a
    // double space, but never cross into the previous token or an earlier cut.
    let start = spans[index].start
    let end = spans[index + sequence.length - 1].end
    const floor = Math.max(index === 0 ? 0 : spans[index - 1].end, cuts.at(-1)?.end ?? 0)
    while (start > floor && ' \t'.includes(value[start - 1])) {
      start -= 1
    }
    // A leading flag has no separator ahead of it, so it takes the one behind.
    if (start === 0) {
      while (end < value.length && ' \t'.includes(value[end])) {
        end += 1
      }
    }
    cuts.push({ start, end })
    index += sequence.length - 1
  }
  let result = value
  for (let index = cuts.length - 1; index >= 0; index -= 1) {
    result = `${result.slice(0, cuts[index].start)}${result.slice(cuts[index].end)}`
  }
  // Why: consecutive leading flags each hand their separator to the next cut,
  // which leaves one behind. Nothing the caller wrote survives ahead of a cut
  // that started at 0, so trimming there cannot lose a byte.
  return result.trim() === '' ? '' : cuts[0]?.start === 0 ? result.trimStart() : result
}

/**
 * Drops the agent's permission-escalation flag from a recorded resume launch
 * when the launch the same agent would get today no longer carries it.
 *
 * Resume prefers the launch config captured when the pane first started, so a
 * user who turns Yolo off keeps getting the old escalation replayed on every
 * app restart (#10886). This only ever removes an escalation, never adds one:
 * a resume must not re-grant permissions the user has since withdrawn, and it
 * must not widen a pane the recorded config launched without them.
 */
export function dropStaleResumePermissionEscalation(args: {
  agent: TuiAgent
  launchConfig: SleepingAgentLaunchConfig
  /** The agent's command override, which may carry the escalation itself. */
  cmdOverride?: string | null
  currentAgentArgs: string
  currentAgentEnv: Record<string, string>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
}): SleepingAgentLaunchConfig {
  const shell = resolveStartupShell(args.platform, args.shell)
  let next = args.launchConfig
  const escalationEnv = YOLO_TUI_AGENT_ENV[args.agent]
  if (escalationEnv) {
    const staleNames = Object.entries(escalationEnv)
      .filter(
        ([name, value]) => next.agentEnv[name] === value && args.currentAgentEnv[name] !== value
      )
      .map(([name]) => name)
    if (staleNames.length > 0) {
      const agentEnv = { ...next.agentEnv }
      for (const name of staleNames) {
        delete agentEnv[name]
      }
      next = { ...next, agentEnv }
    }
  }
  const escalation = YOLO_TUI_AGENT_ARGS[args.agent]?.trim()
  if (!escalation) {
    return next
  }
  const sequence = tokenizeStartupCommand(escalation, shell)
  if (!sequence.ok || sequence.tokens.length === 0) {
    return next
  }
  if (currentLaunchGrantsEscalation(args, sequence.tokens, shell)) {
    return next
  }
  const agentArgs = dropTokenSequence(next.agentArgs, sequence.tokens, shell, 0)
  // Why: the recorded command already embeds the args as quoted tokens, and
  // resume prefers it over agentArgs, so both have to lose the escalation.
  const agentCommand = next.agentCommand
    ? dropTokenSequence(next.agentCommand, sequence.tokens, shell, 1)
    : next.agentCommand
  if (agentArgs === next.agentArgs && agentCommand === next.agentCommand) {
    return next
  }
  return {
    ...next,
    agentArgs,
    ...(agentCommand ? { agentCommand } : {})
  }
}

/** Fails open (reports granted) for any string it cannot tokenize, so an
 * unreadable setting never silently narrows a resumed pane.
 *
 * Why one token list rather than a scan per source: `resolveAgentLaunchCommand`
 * emits the override ahead of the args, so a multi-token escalation can be
 * split across the two — `qwen --approval-mode` plus `yolo` still launches with
 * the flag, and scanning each source alone would call it stale. */
function currentLaunchGrantsEscalation(
  args: { cmdOverride?: string | null; currentAgentArgs: string },
  sequence: readonly string[],
  shell: AgentStartupShell
): boolean {
  const tokens: string[] = []
  for (const source of [args.cmdOverride ?? '', args.currentAgentArgs]) {
    if (!source.trim()) {
      continue
    }
    const tokenized = tokenizeStartupCommand(source, shell)
    if (!tokenized.ok) {
      return true
    }
    tokens.push(...tokenized.tokens)
  }
  return containsTokenSequence(tokens, sequence)
}

export type ResumeLaunchInputs = {
  /** The recorded config with any stale escalation removed, or undefined when
   *  the pane has none and the resume falls back to current settings. */
  launchConfig: SleepingAgentLaunchConfig | undefined
  agentArgs: string
  agentEnv: Record<string, string>
}

/** Resolves what a resume should launch with: the recorded config once its stale
 * escalation is dropped, or the agent's current settings when nothing was
 * recorded. Both resume paths go through here so a change to what "the launch
 * this agent would get today" means cannot be applied to only one of them. */
export function resolveResumeLaunchInputs(args: {
  agent: TuiAgent
  launchConfig: SleepingAgentLaunchConfig | undefined
  settings:
    | Partial<Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv'>>
    | null
    | undefined
  platform: NodeJS.Platform
  shell?: AgentStartupShell
}): ResumeLaunchInputs {
  const currentAgentArgs = resolveTuiAgentLaunchArgs(args.agent, args.settings?.agentDefaultArgs)
  const currentAgentEnv = resolveTuiAgentLaunchEnv(args.agent, args.settings?.agentDefaultEnv)
  if (!args.launchConfig) {
    return { launchConfig: undefined, agentArgs: currentAgentArgs, agentEnv: currentAgentEnv }
  }
  const launchConfig = dropStaleResumePermissionEscalation({
    agent: args.agent,
    launchConfig: args.launchConfig,
    cmdOverride: args.settings?.agentCmdOverrides?.[args.agent],
    currentAgentArgs,
    currentAgentEnv,
    platform: args.platform,
    ...(args.shell ? { shell: args.shell } : {})
  })
  return { launchConfig, agentArgs: launchConfig.agentArgs, agentEnv: launchConfig.agentEnv }
}
