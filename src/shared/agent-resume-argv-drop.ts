import {
  getAgentResumeArgv,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from './agent-session-resume'
import { quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'

/** `dropped` carries the plain launch command; `unrecognized` means the resume
 *  locator is still in there and the caller must refuse the launch rather than
 *  run a resume it could not cancel. */
export type AgentResumeArgvDrop =
  | { status: 'dropped'; command: string }
  | { status: 'absent' }
  | { status: 'unrecognized' }

const RESUME_ARGV_SHELLS: readonly AgentStartupShell[] = ['posix', 'powershell', 'cmd']

function resumeArgvSuffixCandidates(resumeArgs: readonly string[]): string[] {
  const candidates = new Set<string>([resumeArgs.join(' ')])
  for (const shell of RESUME_ARGV_SHELLS) {
    candidates.add(resumeArgs.map((arg) => quoteStartupArg(arg, shell)).join(' '))
  }
  return [...candidates]
}

function stripSuffix(command: string, suffix: string): string | null {
  const base = command.slice(0, command.length - suffix.length)
  // Why: require a whitespace boundary so `codex resume-foo` can't match `resume`.
  if (!command.endsWith(suffix) || !/\s$/.test(base)) {
    return null
  }
  const trimmed = base.trimEnd()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Remove the resume argv `buildAgentResumeStartupPlan` appended, leaving the plain
 * agent launch. Main uses this when it cannot verify which account owns the session,
 * so the pane starts fresh instead of resuming under whichever account is selected.
 */
export function dropAgentResumeArgvFromCommand(args: {
  command: string
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
}): AgentResumeArgvDrop {
  const argv = getAgentResumeArgv(args.agent, args.providerSession)
  const resumeArgs = argv?.slice(1) ?? []
  const locator = resumeArgs.at(-1)
  const command = args.command.trimEnd()
  if (!locator || !command.includes(locator)) {
    return { status: 'absent' }
  }
  for (const suffix of resumeArgvSuffixCandidates(resumeArgs)) {
    const base = stripSuffix(command, suffix)
    if (base !== null && !base.includes(locator)) {
      return { status: 'dropped', command: base }
    }
  }
  return { status: 'unrecognized' }
}
