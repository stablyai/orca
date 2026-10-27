import type { AgentType } from '../../../../shared/agent-status-types'
import {
  createClaudeCatalogOptions,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import { catalogModelsFromModelDiscovery } from '../../../../shared/native-chat-discovered-catalog-models'
import {
  getCommitMessageModelDiscoveryHostKeyForLocalRuntime,
  getCommitMessageModelDiscoveryHostKeyForScope,
  LOCAL_COMMIT_MESSAGE_HOST_KEY
} from '../../../../shared/commit-message-host-key'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import { hasExplicitTuiLaunchCommand } from '../../../../shared/tui-agent-launch-command-override'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  getLocalProjectExecutionRuntimeContext,
  getWslDistroFromPath
} from '@/lib/local-preflight-context'
import { discoverRuntimeCommitMessageModels } from '@/runtime/runtime-git-generation-client'
import { getRuntimeGitScope, type RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionModelOption
} from '../../../../shared/agent-session-wire'
import { useAppStore } from '@/store'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'

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
  // Why: discovery asks the worktree's owner; an owner the rows can't name gets no models.
  const target = worktreeId
    ? runtimeTargetForWorkspaceOwner(state, { workspaceId: worktreeId })
    : ({ kind: 'local' } as const)
  if (!target) {
    return null
  }
  const worktreePath = worktreeId ? (findKnownWorktreeById(state, worktreeId)?.path ?? '') : ''
  const scope = getRuntimeGitScope(target, connectionId)
  return {
    hostKey: resolveNativeChatModelDiscoveryHostKey(state, worktreeId, worktreePath, scope),
    runtime: {
      target,
      prefs: state.settings,
      worktreeId,
      worktreePath,
      ...(connectionId ? { connectionId } : {})
    }
  }
}

function catalogModelsFromHostCatalog(
  agent: 'claude' | 'codex',
  models: AgentSessionModelOption[]
): CatalogModel[] {
  return models.map((model) => ({
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { isDefault: true as const } : {}),
    options:
      agent === 'claude'
        ? createClaudeCatalogOptions({
            effortLevelIds: model.efforts.map((effort) => effort.value),
            ...(model.supportsFastMode !== undefined
              ? { supportsFastMode: model.supportsFastMode }
              : {})
          })
        : []
  }))
}

/** Missing or unsupported host catalogs fall back to CLI listing for mixed-version hosts. */
async function readLocalHostCatalogModels(
  agent: 'claude' | 'codex'
): Promise<CatalogModel[] | null> {
  try {
    const result = await callStructuredAgentSession<AgentSessionModelCatalogResult>(
      { kind: 'local' },
      'agentSession.modelCatalog',
      { agent }
    )
    if (result.origin === 'unknown' || result.models.length === 0) {
      return null
    }
    return catalogModelsFromHostCatalog(agent, result.models)
  } catch {
    return null
  }
}

export async function discoverNativeChatCatalogModels(
  agent: AgentType,
  context: RuntimeGitContext,
  hostKey?: string
): Promise<CatalogModel[] | null> {
  // Use this machine’s host catalog when available; other owners and unlisted hosts use CLI discovery.
  const hostCatalogAgent =
    agent === 'claude' ? ('claude' as const) : agent === 'codex' ? ('codex' as const) : null
  // Only local proves native ownership; paired keys may cover SSH/WSL, and custom commands need CLI discovery.
  if (
    hostCatalogAgent &&
    hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY &&
    !hasExplicitTuiLaunchCommand(context.prefs, hostCatalogAgent)
  ) {
    const fromHost = await readLocalHostCatalogModels(hostCatalogAgent)
    if (fromHost) {
      return fromHost
    }
  }
  return catalogModelsFromModelDiscovery(
    agent,
    await discoverRuntimeCommitMessageModels(context, agent)
  )
}
