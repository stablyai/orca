/**
 * Whether a launch prompt rides the command line that gets TYPED into the user's shell, or the agent
 * starts clean and the prompt is pasted once it is ready. A paste needs a host that can prove the
 * agent holds its terminal (`launched-agent-foreground`); elsewhere the line carries it, as on main.
 *
 * Measured on the built line, not the raw prompt: quoting, the launcher, its arguments and session
 * options all land on that line, and every failure a long or multi-line typed line has is a property
 * of the line — macOS bash 3.2 reads each newline as Enter, a line editor reads any other control
 * byte as a key, a canonical-mode write truncates a line
 * past MAX_CANON (1024 on macOS), and cmd caps a line at 8191. Decided here, where the line exists,
 * so the answer is a fact about what was built rather than a prediction of it.
 *
 * `startup-line-typed-length.live-shell.test.ts` types lines through Orca's own ready barrier and
 * submission into real shells, including one whose config outlasts the barrier's 1.5 s cap so the
 * line lands while the terminal is still line-buffered. Only zsh read a multi-line line whole in
 * both cases, and only while each of its lines stayed short; a long single line was lost there.
 */

import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { buildAgentStartupPlan, type AgentStartupPlan } from './tui-agent-startup'
import type { TuiAgent } from './tui-agent'

/** Half of macOS MAX_CANON: a single typed line this long survived every canonical-mode write
 *  measured, and 1 KiB did not. Also the cap on each line of a multi-line one. */
export const TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES = 512

/** A multi-line line typed into zsh: the largest measured intact behind a late write (8 KiB). */
export const ZSH_MULTI_LINE_STARTUP_LINE_BUDGET_BYTES = 8192

const encoder = new TextEncoder()

function typedLineBytes(line: string): number {
  return encoder.encode(line).byteLength
}

export function startupLineCarriesPrompt(args: {
  agent: TuiAgent
  withPrompt: AgentStartupPlan | null
  /** The shell the line is typed into, when the host can name it before the spawn. */
  shellName?: string
  /** Whether the host can prove the launched agent holds its terminal before it pastes. */
  hostProvesAgentInFront: boolean
}): boolean {
  const { withPrompt } = args
  if (!withPrompt || withPrompt.followupPrompt !== null) {
    return false
  }
  // Where nothing can prove the agent took the terminal, a paste could land in the shell of an
  // agent that exited, so the line carries the prompt at any size, as it always did.
  if (!args.hostProvesAgentInFront) {
    return true
  }
  // Hermes types a fixed line that reads the prompt from the spawn env, so the line never grows
  // with the text; its own env budget already returned null above when the text did not fit.
  if (TUI_AGENT_CONFIG[args.agent].promptInjectionMode === 'hermes-query') {
    return true
  }
  const line = withPrompt.launchCommand
  if (!hasControlByte(line)) {
    return typedLineBytes(line) <= TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES
  }
  return args.shellName === 'zsh' && zshReadsMultiLineWhole(line)
}

/**
 * zsh takes a multi-line line as one bracketed paste, and a write that beats its line editor still
 * reaches it line by line, so each line must fit the terminal's line buffer. bash 3.2 has no
 * bracketed paste, and fish drops a paste written before its reader is up.
 */
function zshReadsMultiLineWhole(line: string): boolean {
  const lines = line.split('\n')
  return (
    lines.every(
      (part) =>
        !hasControlByte(part) && typedLineBytes(part) <= TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES
    ) && typedLineBytes(line) <= ZSH_MULTI_LINE_STARTUP_LINE_BUDGET_BYTES
  )
}

/** Any C0 byte or DEL, not just CR/LF: no quoter escapes them, and a single-line command is written
 *  raw, so a TAB completes, ESC starts a key sequence, and ^C/^U/^W kill or edit the line. */
export function hasControlByte(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

type StartupPlanInputs = Omit<
  Parameters<typeof buildAgentStartupPlan>[0],
  'prompt' | 'allowEmptyPromptLaunch'
>

/**
 * The startup plan for a launch that offers a prompt: the prompted plan when its typed line can
 * carry the text, else the clean plan, with which one it was.
 */
export function planStartupWithPromptCandidate(
  inputs: StartupPlanInputs,
  prompt: string,
  host: { shellName?: string; provesAgentInFront: boolean }
): { plan: AgentStartupPlan | null; promptCarried: boolean } {
  if (prompt.trim()) {
    const withPrompt = buildAgentStartupPlan({ ...inputs, prompt, allowEmptyPromptLaunch: true })
    if (
      startupLineCarriesPrompt({
        agent: inputs.agent,
        withPrompt,
        ...(host.shellName ? { shellName: host.shellName } : {}),
        hostProvesAgentInFront: host.provesAgentInFront
      })
    ) {
      return { plan: withPrompt, promptCarried: true }
    }
  }
  return {
    plan: buildAgentStartupPlan({ ...inputs, prompt: '', allowEmptyPromptLaunch: true }),
    promptCarried: false
  }
}
