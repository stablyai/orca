import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { getRepoSshConnectionId } from '../../../shared/execution-host'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { WorktreeStartupPayload } from './worktree-startup-payload'

export function buildSidebarDefaultAgentStartup(
  settings: GlobalSettings | null,
  repo: Pick<Repo, 'connectionId' | 'path' | 'executionHostId'>,
  projectRuntime?: ProjectExecutionRuntimeResolution
): WorktreeStartupPayload | undefined {
  const agent = settings?.defaultTuiAgent
  if (
    !settings ||
    !agent ||
    agent === 'blank' ||
    !isTuiAgentEnabled(agent, settings.disabledTuiAgents)
  ) {
    return undefined
  }

  const isRemote = repoIsRemote(repo)
  const sshConnectionId = getRepoSshConnectionId(repo)
  const startupPlan = buildAgentStartupPlan({
    agent,
    prompt: '',
    cmdOverrides: settings.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
    sessionOptions: resolveInitialNativeChatSessionOptions(settings, {
      agent,
      nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(sshConnectionId)
    }),
    platform: isRemote
      ? isWindowsAbsolutePathLike(repo.path)
        ? 'win32'
        : 'linux'
      : getAgentLaunchPlatformForRepo(repo, projectRuntime),
    isRemote,
    allowEmptyPromptLaunch: true
  })
  if (!startupPlan) {
    return undefined
  }

  return {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
    ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    telemetry: {
      agent_kind: tuiAgentToAgentKind(agent),
      launch_source: 'sidebar',
      request_kind: 'new'
    }
  }
}
