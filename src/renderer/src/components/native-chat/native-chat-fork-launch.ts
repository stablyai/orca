import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { startStructuredAgentLaunch } from '@/lib/agent-session/launch/structured-agent-session-launch'
import { captureStructuredLaunchSurfaceAddress } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
import type { StructuredLaunchSurfaceAddress } from '@/lib/agent-session/launch/structured-agent-session-launch-record'
import { STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL } from '@/lib/agent-session/launch/structured-agent-session-launch-create-call'
import { structuredLaunchFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import { hostPermissionRefusedText } from '@/lib/agent-session/launch/structured-agent-session-launch-permission-notice'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import {
  StructuredAgentSessionCreateAbandonedError,
  StructuredAgentSessionCreateRefusalError
} from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentSessionForkSource } from '../../../../shared/agent-session/structured-agent-session-create'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type NativeChatForkRequest = {
  agent: TuiAgent
  worktreeId: string
  target: RuntimeClientTarget
  forkFrom: StructuredAgentSessionForkSource
  surfaceAddress: StructuredLaunchSurfaceAddress
}

/** Right after the source chat's tab, in that tab's group; read at the click, before the tab can move. */
export function nativeChatForkSurfaceAddress(
  worktreeId: string,
  sourceTabId: string
): StructuredLaunchSurfaceAddress {
  const group = useAppStore
    .getState()
    .groupsByWorktree[worktreeId]?.find((entry) => entry.tabOrder.includes(sourceTabId))
  if (!group) {
    return captureStructuredLaunchSurfaceAddress(worktreeId)
  }
  return {
    worktreeId,
    targetGroupId: group.id,
    precedingTabIds: group.tabOrder.slice(0, group.tabOrder.indexOf(sourceTabId) + 1)
  }
}

function executionHostIdFor(target: RuntimeClientTarget): ExecutionHostId {
  return target.kind === 'local'
    ? LOCAL_EXECUTION_HOST_ID
    : toRuntimeExecutionHostId(target.environmentId)
}

/** Opens the fork in a new chat tab and says, once, why it didn't; the source chat is never touched. */
export async function launchNativeChatFork(request: NativeChatForkRequest): Promise<void> {
  let launch: ReturnType<typeof startStructuredAgentLaunch> | undefined
  try {
    launch = startStructuredAgentLaunch(request.worktreeId, request.agent, {
      requestId: newAgentLaunchRequestId(),
      executionHostId: executionHostIdFor(request.target),
      forkFrom: request.forkFrom,
      activate: true,
      surfaceAddress: request.surfaceAddress
    })
    await launch.launchResult
  } catch (error) {
    if (error instanceof StructuredAgentSessionCreateAbandonedError) {
      return
    }
    reportNativeChatForkFailure(request.agent, error, launch?.isVisibilityUnknown() === true)
  }
}

function reportNativeChatForkFailure(agent: TuiAgent, error: unknown, unconfirmed: boolean): void {
  const agentLabel = structuredAgentLabel(agent)
  if (unconfirmed) {
    toast.error(
      translate('components.native-chat.fork.unconfirmed', "{{agent}} couldn't confirm the fork", {
        agent: agentLabel
      }),
      {
        description: translate(
          'components.native-chat.fork.unconfirmedDetail',
          'It may have opened anyway. Check Session History before forking again.'
        )
      }
    )
    return
  }
  toast.error(
    translate('components.native-chat.fork.failed', "{{agent}} couldn't fork this chat", {
      agent: agentLabel
    }),
    { description: forkFailureDetail(agentLabel, error) }
  )
}

function forkFailureDetail(agentLabel: string, error: unknown): string {
  const code = error instanceof StructuredAgentSessionCreateRefusalError ? error.code : undefined
  if (code === STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL) {
    return translate(
      'components.native-chat.fork.hostUnsupported',
      'This host runs an older Orca. Update Orca on the host, then try again.'
    )
  }
  if (code === 'structured_agent_session_host_permission') {
    return hostPermissionRefusedText(agentLabel, 'refused')
  }
  const causeText = structuredLaunchFailure(error)?.causeText
  if (causeText) {
    return causeText
  }
  // The host words its own fork refusals ("hasn't finished this response yet").
  if (code !== undefined && error instanceof Error && error.message && error.message !== code) {
    return error.message
  }
  return translate('components.native-chat.fork.failedDetail', 'Your chat is unchanged. Try again.')
}
