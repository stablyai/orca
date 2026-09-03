import type { AgentType } from '../../../../shared/agent-status-types'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import { toDiscoveredCatalogModels } from '../../../../shared/discovered-agent-model-catalog'
import {
  getCommitMessageModelDiscoveryHostKeyForLocalRuntime,
  getCommitMessageModelDiscoveryHostKeyForScope
} from '../../../../shared/commit-message-host-key'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  getLocalProjectExecutionRuntimeContext,
  getWslDistroFromPath
} from '@/lib/local-preflight-context'
import {
  discoverRuntimeCommitMessageModels,
  getRuntimeGitScope,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
import { useAppStore } from '@/store'

export type NativeChatModelDiscoveryContext = {
  hostKey: string
  runtime: RuntimeGitContext
}

export function resolveNativeChatModelDiscoveryHostKey(
  state: Parameters<typeof getLocalProjectExecutionRuntimeContext>[0],
  worktreeId: string | null,
  worktreePath: string,
  scope: string | null | undefined
): string {
  if (scope !== null) {
    return getCommitMessageModelDiscoveryHostKeyForScope(scope)
  }
  const localProjectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  const wslDistro =
    localProjectRuntime?.status === 'resolved' && localProjectRuntime.runtime.kind === 'wsl'
      ? localProjectRuntime.runtime.distro
      : getWslDistroFromPath(worktreePath)
  return getCommitMessageModelDiscoveryHostKeyForLocalRuntime(wslDistro)
}

export function resolveNativeChatModelDiscoveryContext(
  terminalTabId: string
): NativeChatModelDiscoveryContext | null {
  const state = useAppStore.getState()
  const worktreeId =
    Object.entries(state.tabsByWorktree ?? {}).find(([, tabs]) =>
      tabs.some((tab) => tab.id === terminalTabId)
    )?.[0] ?? null
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (worktreeId && connectionId === undefined) {
    return null
  }
  const settings = getSettingsForAgentTabRuntimeOwner(terminalTabId)
  const worktreePath = worktreeId ? (state.getKnownWorktreeById?.(worktreeId)?.path ?? '') : ''
  const scope = getRuntimeGitScope(settings, connectionId)
  return {
    hostKey: resolveNativeChatModelDiscoveryHostKey(state, worktreeId, worktreePath, scope),
    runtime: {
      settings,
      worktreeId,
      worktreePath,
      ...(connectionId ? { connectionId } : {})
    }
  }
}

export async function discoverNativeChatCatalogModels(
  agent: AgentType,
  context: RuntimeGitContext
): Promise<CatalogModel[] | null> {
  const result = await discoverRuntimeCommitMessageModels(context, agent)
  return toDiscoveredCatalogModels(agent, result)
}
