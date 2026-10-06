/** Where a launch prompt rides: decided once here, for every launch path, and switched on by each. */
import {
  MAX_LINE_PROMPT_BYTES,
  carryInLaunchFile,
  launchFileDirectoryPlaceholder,
  type LaunchFile,
  type UnstageableLine
} from './launch-prompt-file'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  quoteStartupArg,
  resolveStartupShell,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import { typedStartupLineFits } from './typed-startup-line'
import type { TuiAgent } from './tui-agent'
import type { LaunchHost } from './launch-host'
import { windowsLaunchLineVerdict } from './windows-launch-line'

/** Why a prefill draft could not be launched, in the user's words: on a Windows host the only
 *  reason a flag-prefilled draft builds no line is the shell's measured damage
 *  (`windowsLaunchLineVerdict`) or the line's length. */
export function windowsDraftRefusal(agent: TuiAgent, platform: NodeJS.Platform): string | null {
  return platform === 'win32' && TUI_AGENT_CONFIG[agent].draftPromptFlag
    ? "The host's Windows shell would break this draft on the agent's command line, so the agent " +
        'was not started. Start it without the draft and paste the draft once it opens.'
    : null
}

/**
 * Where a launch prompt went. Only the carried outcomes hold the plan to launch, so a caller must
 * switch on `carry` before it can launch anything, and cannot mistake a paste for a delivery.
 */
export type LaunchPromptPlan<P> =
  | { carry: 'none'; plan: P }
  | {
      carry: 'on-line'
      plan: P
      /** Sent with the spawn: the line is refused, not typed raw, if the host cannot stage it. */
      unstageableLine?: UnstageableLine
    }
  | { carry: 'launch-file'; plan: P; launchFile: LaunchFile }
  | { carry: 'paste-after-ready'; cleanPlan: P; text: string }

export type LaunchPromptCarry = LaunchPromptPlan<unknown>['carry']

/** Why a create that cannot paste after the agent is ready refuses a prompt that needs it. */
export function launchPromptNeedsPasteRefusal(
  agent: TuiAgent,
  created: 'terminal' | 'session'
): string {
  return TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
    ? `${agent} takes its prompt only after it starts, so no ${created} was created. Start the ` +
        'agent and paste the prompt once it opens.'
    : `${agent} cannot take this prompt on its command line here (it is too long for it), so no ` +
        `${created} was created. Start the agent without it and paste the prompt once it opens.`
}

/**
 * The paste a caller has for a prompt left until the agent is ready:
 * - `never`: none, so the line carries the prompt, as main did;
 * - `when-host-proves-agent`: #24257's guarded paste, refused where the host cannot prove the agent
 *   is in front;
 * - `once-agent-runs`: the desktop paste main uses for AI buttons and notes sends on every host,
 *   written once the agent's process owns the terminal.
 */
export type LaunchPromptPaste = 'never' | 'when-host-proves-agent' | 'once-agent-runs'

export type CarriedPlanArgs = {
  agent: TuiAgent
  prompt: string
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  /** The file `prompt` already points at, when the caller wrote its own. */
  launchFile?: LaunchFile
  /** The host the launch runs on (`describeLaunchHost`). */
  host: LaunchHost
  /** The caller's paste for a prompt the line does not carry. */
  paste: LaunchPromptPaste
}

function agentReadsLaunchFile(agent: TuiAgent): boolean {
  return TUI_AGENT_CONFIG[agent].readsLaunchFile === true
}

const utf8 = new TextEncoder()

/**
 * The one carry rule. A caller that acts once its prompt is sent, on a host that cannot prove the
 * agent is in front (Windows), gets main's paste: nothing there could confirm a carried prompt.
 * Otherwise the prompt rides the agent's line: a host that stages (POSIX, SSH, WSL)
 * stages it when it is long or multi-line, and a Windows host types it when its shell was measured
 * carrying such a line exactly (`windowsLaunchLineVerdict`); an unmeasured one does what main does
 * on the caller's path. When the line cannot (past the argv ceiling, measured damaged by a Windows
 * shell, past the typed budget of a paired host or one that cannot write its staging folder), a
 * caller whose paste main used gets that paste, so the agent receives the user's text. Otherwise it
 * rides a launch file, which goes only to an agent measured reading one, on a host that writes it.
 * Failing a file it is pasted once the agent is ready, unless the caller's paste cannot reach the
 * agent on this host: then the line carries it, as main typed it.
 */
export function carryLaunchPrompt<A extends CarriedPlanArgs, P extends { launchCommand: string }>(
  args: A,
  buildLine: (args: A) => P | null
): LaunchPromptPlan<P> | null {
  const text = args.prompt.trim()
  const shell = resolveStartupShell(args.platform, args.shell)
  const clean = (): P | null => buildLine({ ...args, prompt: '', launchFile: undefined })
  if (!text) {
    const plan = clean()
    return plan && { carry: 'none', plan }
  }
  if (args.launchFile) {
    const plan = buildLine(args)
    return plan && { carry: 'launch-file', plan, launchFile: withQuoting(args.launchFile, shell) }
  }
  const pasteAfterReady = (): LaunchPromptPlan<P> | null => {
    const cleanPlan = clean()
    return cleanPlan && { carry: 'paste-after-ready', cleanPlan, text }
  }
  const mode = TUI_AGENT_CONFIG[args.agent].promptInjectionMode
  if (mode === 'stdin-after-start') {
    return pasteAfterReady()
  }
  // Why: a host that cannot prove the agent is in front cannot confirm a carried prompt either, so
  // a caller that acts once its prompt is sent (AI buttons, notes) gets main's paste and its verdict.
  if (args.paste === 'once-agent-runs' && !args.host.provesAgentInFront) {
    return pasteAfterReady()
  }
  // Why from the caller's paste: main pasted this caller's prompts, so a line the host cannot stage
  // is refused with the prompt to copy rather than typed raw.
  const onLine = (plan: P): LaunchPromptPlan<P> => ({
    carry: 'on-line',
    plan,
    ...(args.paste === 'once-agent-runs' ? { unstageableLine: 'refuse' as const } : {})
  })
  const pasteReachesAgent =
    args.paste === 'once-agent-runs' ||
    (args.paste === 'when-host-proves-agent' && args.host.provesAgentInFront)
  const lineOrPaste = (): LaunchPromptPlan<P> | null => {
    const plan = pasteReachesAgent ? null : buildLine(args)
    return plan ? onLine(plan) : pasteAfterReady()
  }
  const viaLaunchFile = (): LaunchPromptPlan<P> | null => {
    // Why paste first: main pastes this caller's prompts, so the agent gets the user's text; a
    // pointer replaces only a line main would have typed damaged or cut.
    if (args.paste === 'once-agent-runs') {
      return pasteAfterReady()
    }
    // Why: an agent not measured reading the file would stop on an approval or refuse the path.
    if (!args.host.takesLaunchFile || !agentReadsLaunchFile(args.agent)) {
      return lineOrPaste()
    }
    const pointer = carryInLaunchFile(text)
    const plan = buildLine({ ...args, prompt: pointer.prompt, launchFile: pointer.launchFile })
    return (
      plan && { carry: 'launch-file', plan, launchFile: withQuoting(pointer.launchFile, shell) }
    )
  }
  if (utf8.encode(text).byteLength > MAX_LINE_PROMPT_BYTES) {
    return viaLaunchFile()
  }
  const plan = buildLine(args)
  const readsEnv = mode === 'hermes-query'
  if (!plan) {
    // Hermes reads its prompt from the env and refuses one past that budget, counted in bytes; a
    // one-character query building proves the budget, not the command, refused it.
    return readsEnv && buildLine({ ...args, prompt: '.' }) ? viaLaunchFile() : null
  }
  // Hermes's line never holds the text.
  if (readsEnv) {
    return onLine(plan)
  }
  const paneShell = args.host.windowsPaneShell
  // Why not for a WSL pane: it runs the distro's POSIX shell, which the host stages into.
  const windowsLine =
    args.platform === 'win32' && paneShell !== 'wsl.exe'
      ? windowsLaunchLineVerdict(
          text,
          plan.launchCommand,
          shell,
          paneShell === 'powershell.exe' || paneShell === 'pwsh.exe' ? paneShell : null
        )
      : 'exact'
  // Why #24257's typed budget: an older paired host, or a host that cannot write its staging
  // folder, types the line raw, truncated past it.
  const stagesOnHost = args.platform !== 'win32' || paneShell === 'wsl.exe'
  const typesRaw = args.host.paired || (!args.host.takesLaunchFile && stagesOnHost)
  if (windowsLine === 'damaged' || (typesRaw && !typedStartupLineFits(plan.launchCommand))) {
    return viaLaunchFile()
  }
  // Why: unmeasured, so this path does what main does: its paste, or the line it typed.
  if (windowsLine === 'uncertain' && args.paste === 'once-agent-runs') {
    return pasteAfterReady()
  }
  return onLine(plan)
}

/** The host writes the path inside this line's quoting, so the file carries which one it is. */
function withQuoting(launchFile: LaunchFile, shell: AgentStartupShell): LaunchFile {
  return { ...launchFile, quoting: shell }
}

/** The host puts the launch file's private directory where the placeholder is, like its path. */
export function launchFileDirectoryGrant(
  agent: TuiAgent,
  launchFile: LaunchFile | undefined,
  shell: AgentStartupShell
): string {
  const flag = TUI_AGENT_CONFIG[agent].launchFileDirectoryFlag
  if (!launchFile || !flag) {
    return ''
  }
  return ` ${quoteStartupArg(`${flag}=${launchFileDirectoryPlaceholder(launchFile.placeholder)}`, shell)}`
}
