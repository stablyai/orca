import { useEffect, useRef, useState } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { CommitMessageModelCapability } from '../../../../shared/commit-message-agent-spec'
import { getCommitMessageAgentSpec } from '../../../../shared/commit-message-agent-spec'
import type {
  AgentSessionOptionCatalog,
  CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import { discoverRuntimeCommitMessageModels } from '@/runtime/runtime-git-generation-client'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { useAppStore } from '@/store'

export type DiscoveredModels = Partial<Record<TuiAgent, CommitMessageModelCapability[]>>

function getWorkerModelDiscoveryContext(): RuntimeGitContext | null {
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  const worktree = worktreeId ? state.getKnownWorktreeById(worktreeId) : undefined
  const activeRepo = state.repos.find((repo) => repo.id === state.activeRepoId)
  const connectionId = getConnectionIdFromState(state, worktreeId) ?? activeRepo?.connectionId
  // Why: discovery asks the workspace's owner; an owner the store cannot name gets no models.
  const target = worktreeId
    ? runtimeTargetForWorkspaceOwner(state, { workspaceId: worktreeId })
    : ({ kind: 'local' } as const)
  if (!target) {
    return null
  }
  return {
    target,
    prefs: state.settings,
    worktreeId,
    worktreePath: worktree?.path ?? activeRepo?.path ?? '',
    ...(connectionId ? { connectionId } : {})
  }
}

export function toDiscoveredCatalogModel(
  catalog: AgentSessionOptionCatalog,
  model: CommitMessageModelCapability
): CatalogModel {
  const fallbackOptions = catalog.unknownModelOptions ?? []
  const fallbackEffort = fallbackOptions.find((option) => option.id === 'effort')
  if (!model.thinkingLevels?.length || fallbackEffort?.kind.type !== 'select') {
    return { id: model.id, label: model.label, options: fallbackOptions }
  }

  const choices = model.thinkingLevels.map(({ id, label }) => ({
    value: id,
    label
  }))
  const defaultValue =
    (model.defaultThinkingLevel &&
      choices.some((choice) => choice.value === model.defaultThinkingLevel) &&
      model.defaultThinkingLevel) ||
    (choices.some((choice) => choice.value === fallbackEffort.kind.defaultValue)
      ? fallbackEffort.kind.defaultValue
      : choices[0].value)
  const discoveredEffort = {
    ...fallbackEffort,
    kind: { ...fallbackEffort.kind, choices, defaultValue }
  }

  return {
    id: model.id,
    label: model.label,
    options: fallbackOptions.map((option) => (option.id === 'effort' ? discoveredEffort : option))
  }
}

// Why: each probe spawns an agent process, so probe only the agent whose models are
// on screen and keep that answer until the execution host changes.
export function useDiscoveredWorkerModels(selectedAgent: TuiAgent | null): DiscoveredModels {
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModels>({})
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeWorktreePath = useAppStore((state) => {
    const worktreeId = state.activeWorktreeId
    return worktreeId ? (state.getKnownWorktreeById(worktreeId)?.path ?? '') : ''
  })
  const activeRepoPath = useAppStore(
    (state) => state.repos.find((repo) => repo.id === state.activeRepoId)?.path ?? ''
  )
  const activeConnectionId = useAppStore((state) =>
    getConnectionIdFromState(state, state.activeWorktreeId)
  )
  // Why: discovery routes by the workspace's owner, so the Active Server setting cannot change
  // the answer and does not belong in the cache key.
  const discoveryHostKey = [
    activeConnectionId ?? '',
    activeWorktreeId ?? '',
    activeWorktreePath,
    activeRepoPath
  ].join('\u0000')
  const probedRef = useRef<{ hostKey: string; agents: Set<TuiAgent> }>({
    hostKey: discoveryHostKey,
    agents: new Set()
  })

  useEffect(() => {
    if (probedRef.current.hostKey !== discoveryHostKey) {
      probedRef.current = { hostKey: discoveryHostKey, agents: new Set() }
      setDiscoveredModels({})
    }
    const agent = selectedAgent
    if (
      !agent ||
      getCommitMessageAgentSpec(agent)?.modelSource !== 'dynamic' ||
      probedRef.current.agents.has(agent)
    ) {
      return
    }
    const context = getWorkerModelDiscoveryContext()
    if (!context) {
      return
    }
    probedRef.current.agents.add(agent)
    const forget = () => {
      if (probedRef.current.hostKey === discoveryHostKey) {
        probedRef.current.agents.delete(agent)
      }
    }
    void discoverRuntimeCommitMessageModels(context, agent)
      .then((result) => {
        // Why: the cache is per host, so a reply that outlives a host change is stale.
        if (probedRef.current.hostKey !== discoveryHostKey) {
          return
        }
        if (!result.success) {
          forget()
          return
        }
        setDiscoveredModels((current) => ({ ...current, [agent]: result.models }))
      })
      .catch(forget)
  }, [discoveryHostKey, selectedAgent])

  return discoveredModels
}
