import type { AgentType } from '../../../../shared/agent-status-types'
import {
  claudeModelSupportsContextWindow,
  createClaudeCatalogOptions,
  createCodexCatalogOptions,
  getAgentSessionOptionCatalog,
  normalizeClaudeModelId,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
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
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'

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

export function resolveRoomModelDiscoveryContext(
  worktreeId: string
): NativeChatModelDiscoveryContext | null {
  const state = useAppStore.getState()
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (connectionId === undefined) {
    return null
  }
  const settings = getSettingsForWorktreeRuntimeOwner(state, worktreeId)
  const worktreePath = state.getKnownWorktreeById?.(worktreeId)?.path ?? ''
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
): Promise<{
  models: CatalogModel[]
  reportedValues?: Record<string, SessionOptionValue>
} | null> {
  const result = await discoverRuntimeCommitMessageModels(context, agent, {
    includeSessionDefaults: true
  })
  const catalog = getAgentSessionOptionCatalog(agent)
  if (
    !result.success ||
    result.models.length === 0 ||
    // Why: a spec's static fallback list must never pass as a probe result for an
    // agent whose published list replaces rather than extends the seed.
    ((agent === 'claude' || catalog?.discoveredModelsAreAuthoritative) &&
      result.catalogOrigin !== 'probe')
  ) {
    return null
  }
  const seedModels = catalog?.models ?? []
  const defaultModelId =
    agent === 'claude' ? normalizeClaudeModelId(result.defaultModelId ?? '') : result.defaultModelId
  // Why: normalization can fold provider aliases onto one id; the map keeps the
  // last row so a folded alias cannot surface twice in the picker.
  const modelsById = new Map<string, CatalogModel>()
  for (const model of result.models) {
    const id = agent === 'claude' ? normalizeClaudeModelId(model.id) : model.id
    const choices = model.thinkingLevels?.map(({ id, label }) => ({ value: id, label })) ?? []
    modelsById.set(id, {
      id,
      label: seedModels.find((seed) => seed.id === id)?.label ?? model.label,
      ...(model.description ? { description: model.description } : {}),
      ...(model.isDefault || id === defaultModelId ? { isDefault: true as const } : {}),
      options:
        agent === 'claude'
          ? createClaudeCatalogOptions({
              effortLevelIds: model.thinkingLevels?.map(({ id }) => id) ?? [],
              supportsFastMode: model.supportsFastMode,
              supportsContextWindow: claudeModelSupportsContextWindow(id)
            })
          : agent === 'codex'
            ? createCodexCatalogOptions({
                effortChoices: choices,
                defaultEffort: model.defaultThinkingLevel,
                supportsFastMode: model.supportsFastMode
              })
            : []
    })
  }
  const configured = result.models.find((model) => model.id === result.defaultModelId)
  return {
    models: [...modelsById.values()],
    // Why: the Codex config's model/effort are what the CLI will actually run;
    // report them so the pickers show the real session state, not seed defaults.
    ...(agent === 'codex' && configured
      ? {
          reportedValues: {
            model: configured.id,
            ...(configured.defaultThinkingLevel ? { effort: configured.defaultThinkingLevel } : {})
          }
        }
      : {})
  }
}
