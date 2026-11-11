import type { AgentProviderSessionMetadata } from '../../agent-session/lifecycle/agent-session-resume'
import type {
  AiVaultResumeHostShell,
  AiVaultResumeLaunchSettings
} from '../../ai-vault/resume/ai-vault-resume-startup'
import {
  OMP_SIDE_CHAT_DIR_ENV,
  isOmpSideChatTranscriptPath,
  ompSideChatDir
} from './omp-side-chat-session'
import type { SideChatStartup } from './side-chat'
import { TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../choices/tui-agent-launch-defaults'
import { buildAgentResumeStartupPlan } from '../startup/tui-agent-resume-startup'

/**
 * The side chat is `omp --fork` of the parent's transcript into its own folder. omp cannot fork
 * without saving, so Orca's omp extension (keyed by OMP_SIDE_CHAT_DIR_ENV) adds the hidden boundary
 * on start and deletes the folder on exit. The fork restores the parent's model and thinking level.
 */
export function buildOmpSideChatStartup(args: {
  parentSession: AgentProviderSessionMetadata
  sideChatId: string
  host: Pick<AiVaultResumeHostShell, 'platform' | 'liveShell'>
  settings: AiVaultResumeLaunchSettings | null | undefined
  draftPrompt?: string | null
}): SideChatStartup | null {
  const { parentSession, host, settings } = args
  // A path-less session cannot be forked reliably, and a side chat never seeds another.
  const parentPath = parentSession.transcriptPath?.trim()
  if (
    parentSession.key !== 'session_id' ||
    !parentPath ||
    isOmpSideChatTranscriptPath(parentPath)
  ) {
    return null
  }
  const sideChatDir = ompSideChatDir(parentPath, args.sideChatId)
  if (!sideChatDir) {
    return null
  }
  const plan = buildAgentResumeStartupPlan({
    agent: 'omp',
    providerSession: parentSession,
    cmdOverrides: { ...settings?.agentCmdOverrides },
    platform: host.platform,
    shell: host.liveShell,
    agentArgs: resolveTuiAgentLaunchArgs('omp', settings),
    agentEnv: resolveTuiAgentLaunchEnv('omp', settings, host.platform),
    fork: true,
    forkArgv: ['omp', '--fork', parentPath, '--session-dir', sideChatDir]
  })
  if (!plan) {
    return null
  }
  const draft = args.draftPrompt?.trim() ? args.draftPrompt : null
  const draftEnvVar = TUI_AGENT_CONFIG.omp.draftPromptEnvVar
  return {
    command: plan.launchCommand,
    env: {
      ...plan.env,
      [OMP_SIDE_CHAT_DIR_ENV]: sideChatDir,
      ...(draft && draftEnvVar ? { [draftEnvVar]: draft } : {})
    }
  }
}
