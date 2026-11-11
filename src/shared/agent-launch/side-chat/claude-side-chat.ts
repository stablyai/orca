import type { AgentProviderSessionMetadata } from '../../agent-session/lifecycle/agent-session-resume'
import { buildAiVaultResumeShellCommand } from '../../ai-vault/resume/ai-vault-resume-command'
import type {
  AiVaultResumeHostShell,
  AiVaultResumeLaunchSettings
} from '../../ai-vault/resume/ai-vault-resume-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../choices/tui-agent-launch-defaults'
import { buildAgentResumeStartupPlan } from '../startup/tui-agent-resume-startup'
import { isClaudeSideChatSessionId } from './claude-side-chat-session-id'
import { SIDE_CHAT_CONTEXT, type SideChatStartup } from './side-chat'

export {
  createClaudeSideChatSessionId,
  isClaudeSideChatSessionId
} from './claude-side-chat-session-id'

/** Settings for the forked process: no transcript on disk, and the boundary injected as hidden context on fork start. */
export function buildClaudeSideChatSettings(): string {
  const hookOutput = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: SIDE_CHAT_CONTEXT
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

/** The side chat runs where the parent's agent ran, with the user's Claude launch defaults. */
export function buildClaudeSideChatStartup(args: {
  parentSession: AgentProviderSessionMetadata
  sideSessionId: string
  host: Pick<AiVaultResumeHostShell, 'platform' | 'liveShell'>
  settings: AiVaultResumeLaunchSettings | null | undefined
  model?: string | null
  draftPrompt?: string | null
}): SideChatStartup | null {
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
