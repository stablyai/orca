import { z } from 'zod'
import { normalizeAgentProviderSession, RESUMABLE_TUI_AGENTS } from './agent-session-resume'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'
import { resolveWindowsShellStartupFamily } from './windows-terminal-shell'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { buildShellCommandFromArgv, tokenizeStartupCommand } from './tui-agent-startup-shell'

export const agentResumeCommandSchema = z.object({
  agent: z.enum(RESUMABLE_TUI_AGENTS),
  // Why preprocess: this id is typed into a live shell; apply the same length and
  // control-character rejection every other provider-session boundary uses.
  providerSession: z.preprocess(
    (raw) => normalizeAgentProviderSession(raw) ?? undefined,
    z.object({
      key: z.enum(['session_id', 'conversation_id']),
      id: z.string().min(1),
      transcriptPath: z.string().optional()
    })
  ),
  cmdOverrides: z.record(z.string(), z.string()),
  agentArgs: z.string().nullish(),
  agentCommand: z.string().nullish(),
  ompResumeFilePath: z.string().nullish(),
  sessionOptions: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  sessionOptionsOverrideAgentArgs: z.boolean().optional(),
  sourceShell: z.enum(['cmd', 'powershell', 'posix']).optional()
})

export type AgentResumeCommand = z.infer<typeof agentResumeCommandSchema>

export class AgentResumeShellMismatchError extends Error {}

/** Only the process owner knows which shell attempt will receive the command. */
export function resolveAgentResumeCommand(
  request: AgentResumeCommand | undefined,
  shellPath: string,
  fallbackCommand?: string
): string | undefined {
  if (!request) {
    return fallbackCommand
  }
  const shell = resolveWindowsShellStartupFamily(shellPath)
  const sourceShell = request.sourceShell ?? shell
  let agentCommand = request.agentCommand
  if (sourceShell !== shell) {
    // Shell scripts cannot be translated as literal argv during fallback.
    const customCommand = agentCommand?.trim() || request.cmdOverrides[request.agent]
    if (customCommand && /[$`%!\u2018\u2019\u201c\u201d\r\n]/u.test(customCommand)) {
      throw new AgentResumeShellMismatchError(
        'The custom agent command requires its configured shell.'
      )
    }
    const base = agentCommand?.trim()
      ? { ok: true as const, command: agentCommand }
      : resolveAgentLaunchCommand({
          ...request,
          platform: 'win32',
          shell: sourceShell
        })
    if (!base.ok) {
      throw new Error(base.error)
    }
    const parsed = tokenizeStartupCommand(base.command, sourceShell)
    if (
      !parsed.ok ||
      parsed.spans.some(
        (span, index) =>
          span.divergesFromShell &&
          !(sourceShell === 'powershell' && index === 0 && parsed.tokens[0] === '&')
      )
    ) {
      throw new AgentResumeShellMismatchError(
        'The custom agent command requires its configured shell.'
      )
    }
    const tokens =
      sourceShell === 'powershell' && parsed.tokens[0] === '&'
        ? parsed.tokens.slice(1)
        : parsed.tokens
    agentCommand = buildShellCommandFromArgv(tokens, shell)
  }
  const plan = buildAgentResumeStartupPlan({
    ...request,
    agentCommand,
    platform: /(?:^|[\\/])wsl\.exe$/i.test(shellPath) ? 'linux' : 'win32',
    shell
  })
  if (!plan) {
    throw new Error('The agent resume command could not be built for the selected shell.')
  }
  return plan.launchCommand
}

/** Delivery-time variant: a resume that cannot be expressed for the winning shell
 *  is dropped — never mis-quoted, and never allowed to cost the user the terminal. */
export function resolveAgentResumeDeliveryCommand(
  request: AgentResumeCommand | undefined,
  shellPath: string,
  fallbackCommand?: string
): string | undefined {
  try {
    return resolveAgentResumeCommand(request, shellPath, fallbackCommand)
  } catch (error) {
    if (error instanceof AgentResumeShellMismatchError) {
      return undefined
    }
    throw error
  }
}
