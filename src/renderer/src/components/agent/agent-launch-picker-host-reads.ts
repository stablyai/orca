import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import {
  agentPickerListsCliModels,
  readAgentPickerCliModelCatalog
} from './agent-launch-picker-cli-model-catalog'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import {
  readModelMenuCatalog,
  type ModelMenuReadScope
} from '@/runtime/native-chat/model-catalogs/model-menu-catalog-read'
import { subscribeModelMenuInvalidation } from '@/runtime/native-chat/model-catalogs/model-menu-invalidation'
import { parseStructuredLaunchSeedOptions } from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import { isAgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export function agentPickerModelCatalogReads(
  input: Omit<ModelMenuReadScope, 'agent' | 'target'> & {
    target: RuntimeClientTarget | null
    cliDiscoveryRuntime?: RuntimeGitContext | null
  }
) {
  const { target, cliDiscoveryRuntime } = input
  return {
    catalog: async (entry: AgentPickerEntry, waitForListing: boolean, signal: AbortSignal) =>
      cliDiscoveryRuntime && agentPickerListsCliModels(entry)
        ? readAgentPickerCliModelCatalog(entry.agent, cliDiscoveryRuntime)
        : !target
          ? undefined
          : entry.agent === 'antigravity'
            ? callStructuredAgentSession<AgentSessionModelCatalogResult>(
                target,
                'agentSession.modelCatalog',
                {
                  ...(input.worktree ? { worktree: input.worktree } : {}),
                  agent: entry.agent,
                  ...(waitForListing ? { waitForListing } : {})
                }
              )
            : readModelMenuCatalog(
                { ...input, target, agent: entry.agent },
                waitForListing,
                signal
              ),
    refreshOnInvalidation: (entry: Pick<AgentPickerEntry, 'agent'>) =>
      !!target &&
      !(cliDiscoveryRuntime && agentPickerListsCliModels(entry)) &&
      entry.agent !== 'antigravity',
    subscribeInvalidation: target
      ? (listener: () => void) => subscribeModelMenuInvalidation(target, listener)
      : undefined
  }
}

export async function readAgentPickerLaunchSupport(
  target: RuntimeClientTarget | null,
  selector: string | undefined,
  agent: AgentPickerEntry['agent']
): Promise<AgentPickerEntry['structured'] | undefined> {
  if (!selector || !target) {
    return undefined
  }
  const support = await callStructuredAgentSession<{ seedOptions?: Record<string, string> }>(
    target,
    'agentSession.createSupport',
    { worktree: selector, agent }
  )
  const parsed = parseStructuredLaunchSeedOptions(support?.seedOptions)
  if (!parsed) {
    return undefined
  }
  const { model, permissionMode, ...options } = parsed
  return {
    ...(model ? { model } : {}),
    options,
    ...(isAgentChatPermissionChoice(permissionMode) ? { permissionMode } : {})
  }
}
