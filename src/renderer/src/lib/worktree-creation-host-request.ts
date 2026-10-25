import { freezeDesktopCreateParams } from './structured-agent-session-launch-record'
import type { useAppStore } from '@/store'

import { createBrowserUuid } from '@/lib/browser-uuid'

import type { resolveWorktreeCreateParent } from '@/store/slices/worktrees/create/worktree-create-parent-pick'
import { buildRuntimeWorktreeCreateParams } from '@/store/slices/worktrees/create/worktree-create-payload'
import { pickClientWorktreeCreateSettings } from '@/store/slices/worktrees/create/client-worktree-create-settings'
import { createStructuredAgentSessionId } from '../../../shared/structured-agent-session-create'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'

import { AgentLaunchReplay } from '../../../shared/rpc-contract/agent-launch-params'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import type { TuiAgent } from '../../../shared/tui-agent'

import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export function captureHostWorktreeLaunchRequest(
  creationId: string,
  request: WorktreeCreationRequest,
  state: ReturnType<typeof useAppStore.getState>,
  agent: TuiAgent,
  executionHostId: ExecutionHostId,
  parent: ReturnType<typeof resolveWorktreeCreateParent>,
  target: RuntimeClientTarget
): NonNullable<WorktreeCreationRequest['hostAgentLaunch']> {
  const operationId = createStructuredAgentSessionOperationId(createBrowserUuid)
  const sessionId = createStructuredAgentSessionId(agent, createBrowserUuid)
  const paneKey = `${createBrowserUuid()}:${createBrowserUuid()}`
  const text = request.launchDraftPrompt ?? request.quickPrompt
  const create = {
    ...buildRuntimeWorktreeCreateParams(
      {
        ...request,
        startup: undefined,
        createdWithAgent: agent,
        creationId,
        options: {
          nameWasGenerated: request.nameWasGenerated,
          displayNameKind: request.displayNameKind,
          linkedWorkItem: request.linkedWorkItem,
          linkedTaskSourceContext: request.linkedTaskSourceContext
        }
      },
      {
        name: request.name,
        branchNameOverride: request.branchNameOverride,
        parentWorkspace: parent.parentWorkspace,
        manualOrder: state.sortBy === 'manual' ? Date.now() : undefined
      }
    ),
    ...pickClientWorktreeCreateSettings(state.settings),
    creationId,
    repoHostId: executionHostId
  }
  const params = freezeDesktopCreateParams(
    AgentLaunchReplay.parse(
      structuredClone({
        agent,
        operationId,
        createIdentity: { instanceId: createBrowserUuid() },
        sessionId,
        paneKey,
        target: { kind: 'create-worktree' as const, create },
        surface: 'chat' as const,
        ...(text
          ? {
              prompt: {
                text,
                delivery:
                  request.promptDelivery === 'draft' ? ('draft' as const) : ('submit' as const)
              }
            }
          : {}),
        agentArgs: request.startupPlan?.launchConfig?.agentArgs,
        launchSource: request.quickTelemetry?.launch_source ?? 'new_workspace_composer',
        sessionOptions: Object.fromEntries(
          Object.entries(request.startupPlan?.sessionOptions ?? {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      })
    )
  )
  return {
    operationId,
    sessionId,
    paneKey,
    params,
    target,
    executionHostId,
    pairingRevision:
      target.kind === 'environment'
        ? getRuntimeEnvironmentRevision(target.environmentId)
        : undefined,
    issued: false
  }
}
