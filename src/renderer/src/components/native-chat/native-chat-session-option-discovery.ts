import type { AgentType } from '../../../../shared/agent-status-types'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import { getCommitMessageModelDiscoveryHostKeyForScope } from '../../../../shared/commit-message-host-key'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { getConnectionIdFromState } from '@/lib/connection-context'
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
    hostKey: getCommitMessageModelDiscoveryHostKeyForScope(scope),
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
  if (!result.success || result.models.length === 0) {
    return null
  }
  return result.models.map((model) => ({
    id: model.id,
    label: model.label,
    options: []
  }))
}
