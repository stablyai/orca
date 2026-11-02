/** Choose prompt delivery from the built, quoted line: control bytes edit/submit, MAX_CANON truncates (1024 on macOS),
 * and cmd caps at 8191. Paste fallback requires launched-agent-foreground proof or it could reach an exited agent’s shell.
 * startup-line-typed-length.live-shell.test.ts measures real shells through the ready barrier, including config beyond its 1.5s cap;
 * only zsh preserved multiline input in both timings, with short individual lines. Long zsh lines still failed. */

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
  // Without foreground proof, paste could reach an exited agent’s shell; retain the prompt on the line at any size.
  if (!args.hostProvesAgentInFront) {
    return true
  }
  // Hermes reads prompt env, so line length stays fixed; its env budget already rejected oversized input above.
  if (TUI_AGENT_CONFIG[args.agent].promptInjectionMode === 'hermes-query') {
    return true
  }
  const line = withPrompt.launchCommand
  if (!hasControlByte(line)) {
    return typedLineBytes(line) <= TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES
  }
  return args.shellName === 'zsh' && zshReadsMultiLineWhole(line)
}

/** Early zsh paste still passes through the canonical per-line buffer; bash 3.2 lacks paste and early fish consumes it. */
function zshReadsMultiLineWhole(line: string): boolean {
  const lines = line.split('\n')
  return (
    lines.every(
      (part) =>
        !hasControlByte(part) && typedLineBytes(part) <= TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES
    ) && typedLineBytes(line) <= ZSH_MULTI_LINE_STARTUP_LINE_BUDGET_BYTES
  )
}

/** Raw C0/DEL bytes edit the line (TAB completion, ESC sequences, Ctrl-C/U/W), even without CR/LF. */
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
