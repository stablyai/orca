import type { AgentProviderSessionMetadata } from './agent-session-resume'
import { buildAiVaultResumeShellCommand } from './ai-vault-resume-command'
import type { AiVaultResumeHostShell, AiVaultResumeLaunchSettings } from './ai-vault-resume-startup'
import { resolveTuiAgentLaunchArgs, resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'
import { isClaudeSideChatSessionId } from './claude-side-chat-session-id'

export {
  createClaudeSideChatSessionId,
  isClaudeSideChatSessionId
} from './claude-side-chat-session-id'

// Why no apostrophes, backslashes or newlines: the hook echoes it single-quoted from sh, Git Bash and PowerShell alike.
export const CLAUDE_SIDE_CHAT_CONTEXT = [
  'Side conversation boundary.',
  'Everything before this point is inherited history from the main Claude Code session, which runs in another Orca pane and may still be working.',
  'It is reference context only, not your current task.',
  'Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this point.',
  'Only messages the user sends after this point are active instructions for this side conversation.',
  'You are a side-conversation assistant, separate from the main session.',
  'Answer questions and do lightweight, non-mutating exploration such as reading or searching files and running read-only checks, without disrupting the main session.',
  'If there is no user question yet, wait for one.',
  'Do not modify files, source, git state, permissions, configuration, or other workspace state unless the user explicitly asks for that mutation in this side conversation; if they do, keep it minimal and local to the request.',
  'Do not start subagents, background tasks, or new worktrees here; point such requests back to the main session.',
  'This side conversation is temporary and is discarded when its pane closes.'
].join(' ')

/** Settings for the forked process: no transcript on disk, and the boundary injected as hidden context on fork start. */
export function buildClaudeSideChatSettings(): string {
  const hookOutput = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: CLAUDE_SIDE_CHAT_CONTEXT
    }
  })
  return JSON.stringify({
    env: { CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' },
    hooks: {
      SessionStart: [
        { matcher: 'fork', hooks: [{ type: 'command', command: `echo '${hookOutput}'` }] }
      ]
    }
  })
}

const CLAUDE_MODEL_ARG_PATTERN = /^[A-Za-z0-9][\w.:@/[\]-]*$/

export function buildClaudeSideChatForkArgs(args: {
  sideSessionId: string
  effort?: string | null
  model?: string | null
  draftPrompt?: string | null
}): string[] {
  const model = args.model?.trim()
  const draft = args.draftPrompt?.trim() ? args.draftPrompt : null
  return [
    '--session-id',
    args.sideSessionId,
    '--settings',
    buildClaudeSideChatSettings(),
    // Fork argv omits the effort that plain resume replays; the side chat keeps the parent's.
    ...(args.effort ? ['--effort', args.effort] : []),
    ...(model && CLAUDE_MODEL_ARG_PATTERN.test(model) ? ['--model', model] : []),
    ...(draft ? ['--prefill', draft] : [])
  ]
}

export type ClaudeSideChatStartup = { command: string; env?: Record<string, string> }

/** The side chat runs where the parent's agent ran, with the user's Claude launch defaults. */
export function buildClaudeSideChatStartup(args: {
  parentSession: AgentProviderSessionMetadata
  sideSessionId: string
  host: Pick<AiVaultResumeHostShell, 'platform' | 'liveShell'>
  settings: AiVaultResumeLaunchSettings | null | undefined
  model?: string | null
  draftPrompt?: string | null
}): ClaudeSideChatStartup | null {
  const { parentSession, host, settings } = args
  if (parentSession.key !== 'session_id' || isClaudeSideChatSessionId(parentSession.id)) {
    return null
  }
  const plan = buildAgentResumeStartupPlan({
    agent: 'claude',
    providerSession: parentSession,
    cmdOverrides: { ...settings?.agentCmdOverrides },
    platform: host.platform,
    shell: host.liveShell,
    agentArgs: resolveTuiAgentLaunchArgs('claude', settings),
    agentEnv: resolveTuiAgentLaunchEnv('claude', settings, host.platform),
    resumeInLaunchCwd: true,
    fork: true,
    forkArgs: buildClaudeSideChatForkArgs({
      sideSessionId: args.sideSessionId,
      effort: parentSession.effort,
      model: args.model,
      draftPrompt: args.draftPrompt
    })
  })
  if (!plan) {
    return null
  }
  const env = plan.env && Object.keys(plan.env).length > 0 ? plan.env : undefined
  return {
    command: buildAiVaultResumeShellCommand({
      resumeCommand: plan.launchCommand,
      cwd: parentSession.cwd?.trim() || null,
      platform: host.platform,
      shell: host.liveShell
    }),
    ...(env ? { env } : {})
  }
}
