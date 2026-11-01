import {
  getAgentResumeArgv,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from './agent-session-resume'
import { quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'

/** Unrecognized locators require refusal: the caller cannot safely launch a resume it could not cancel. Dropped returns the plain launch command. */
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

/** Strip appended resume argv when account ownership is unverifiable so launch starts fresh. Trailing-only: Claude selectors before -- remain unrecognized and must be refused. */
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
