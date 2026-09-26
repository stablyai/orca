import type { AgentType } from '../../../../shared/agent-status-types'
import {
  createClaudeCatalogOptions,
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import {
  getCommitMessageModelDiscoveryHostKeyForLocalRuntime,
  getCommitMessageModelDiscoveryHostKeyForScope,
  LOCAL_COMMIT_MESSAGE_HOST_KEY
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
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionModelOption
} from '../../../../shared/agent-session-wire'
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

/** Null when the host has no listing yet or predates the surface (`forbidden`
 *  or `method_not_found`) — the caller then falls back to the CLI listing. */
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
  // Claude/Codex on this machine read its host model catalog; the CLI listing
  // below remains for every other host and while this one has never listed.
  const hostCatalogAgent =
    agent === 'claude' ? ('claude' as const) : agent === 'codex' ? ('codex' as const) : null
  // Only `local` proves a native pane: a paired runtime's key also covers its SSH/WSL worktrees.
  if (hostCatalogAgent && hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY) {
    const fromHost = await readLocalHostCatalogModels(hostCatalogAgent)
    if (fromHost) {
      return fromHost
    }
  }
  const result = await discoverRuntimeCommitMessageModels(context, agent)
  const catalog = getAgentSessionOptionCatalog(agent)
  if (
    !result.success ||
    result.models.length === 0 ||
    // Why: a spec's static fallback list must never pass as a probe result for an
    // agent whose published list decides membership rather than only adding to the seed.
    ((agent === 'claude' || catalog?.discoveredModelsAreAuthoritative) &&
      result.catalogOrigin !== 'probe')
  ) {
    return null
  }
  return result.models.map((model) => ({
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { isDefault: true as const } : {}),
    options:
      agent === 'claude'
        ? createClaudeCatalogOptions({
            effortLevelIds: model.thinkingLevels?.map(({ id }) => id) ?? [],
            supportsFastMode: model.supportsFastMode
          })
        : []
  }))
}
