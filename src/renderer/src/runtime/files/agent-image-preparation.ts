import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import { getRemoteRuntimePtyOwner } from '../hosted-terminals/identity/remote-runtime-pty-owner'
import { runtimeTargetForOwnerEnvironment } from '../rpc/targets/runtime-client-target'
import { useAppStore } from '@/store/index'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'

export async function prepareAgentImagePaths(
  ptyId: string,
  paths: readonly string[],
  environmentId?: string | null
): Promise<string[]> {
  const owner = getRemoteRuntimePtyOwner(ptyId)
  const result = await callRuntimeRpc<{ paths: string[] }>(
    owner?.target ?? runtimeTargetForOwnerEnvironment(environmentId ?? null),
    'files.prepareAgentImages',
    { paths },
    { timeoutMs: 120_000 }
  )
  return result.paths
}

export function prepareTerminalAgentImagePaths(
  tabId: string,
  leafId: string,
  ptyId: string | null,
  paths: readonly string[],
  environmentId?: string | null
): Promise<string[]> {
  const state = useAppStore.getState()
  const key = `${tabId}:${leafId}`
  const entry = state.agentStatusByPaneKey.get(key)
  const foreground = state.paneForegroundAgentByPaneKey[key]?.agent
  const agent = isTuiAgent(foreground)
    ? foreground
    : entry?.restoredUnconfirmed !== true
      ? entry?.agentType
      : null
  return ptyId && isTuiAgent(agent)
    ? prepareAgentImagePaths(ptyId, paths, environmentId)
    : Promise.resolve([...paths])
}
