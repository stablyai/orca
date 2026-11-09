import type { ModelCatalogSource } from '../../../../../shared/agent-session/options/model-catalog-source'
import { useCallback, useEffect, useMemo } from 'react'
import {
  useAppStateViewActive,
  useAppViewExternalStore
} from '@/store/retained-views/app-state-view'
import {
  hostModelMenuCatalog,
  type HostModelMenuScope,
  type HostModelMenuSnapshot
} from '@/runtime/native-chat/model-catalogs/host-model-menu-catalog'
import { modelMenuOptions } from '../../../../../shared/agent-session/options/model-menu-options'
import { getAgentSessionOptionLaunchCatalog } from '../../../../../shared/agent-session/options/agent-session-option-catalog'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentDedicatedChoices } from '../../../../../shared/agent-launch/choices/agent-launch-choices'
import { structuredAgentSessionHostKey } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'

export type AgentModelMenuSource = {
  scope: HostModelMenuScope
  coherentCatalog: boolean
  source?: ModelCatalogSource
}
const absent: HostModelMenuSnapshot = { pending: false, generation: 0 }
const subscribeAbsent = () => () => {}

export function useAgentModelMenu(
  agent: TuiAgent,
  saved: AgentDedicatedChoices | undefined,
  source: AgentModelMenuSource | undefined,
  open: boolean
) {
  const active = useAppStateViewActive()
  const key = source ? structuredAgentSessionHostKey(source.scope.target) : null
  const scope = useMemo(
    () => source?.scope,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Scope identity is host/agent/worktree, not the caller's object.
    [key, agent, source?.scope.worktree, source?.scope.sourceKey]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      scope ? hostModelMenuCatalog(scope).subscribe(listener) : subscribeAbsent(),
    [scope]
  )
  const getSnapshot = useCallback(
    () => (scope ? hostModelMenuCatalog(scope).snapshot : absent),
    [scope]
  )
  const snapshot = useAppViewExternalStore(subscribe, getSnapshot, () => absent)
  useEffect(() => {
    if (scope && open && active) {
      void hostModelMenuCatalog(scope).read(source?.source === 'cli')
    }
  }, [scope, open, active, snapshot.generation, source?.source])
  const menu = modelMenuOptions(snapshot.answer, {
    agent,
    surface: 'terminal',
    seed: getAgentSessionOptionLaunchCatalog(agent) ?? { models: [], modelApply: {} },
    pending: !!source && (snapshot.pending || !snapshot.attempted),
    coherentCatalog: source?.coherentCatalog,
    saved: { ...(saved?.model ? { model: saved.model } : {}), ...saved?.options },
    newLaunch: true,
    seedsModel: false
  })
  return {
    ...menu,
    source: source?.source ?? 'structured',
    fallbackAfterFailure:
      !!source && snapshot.attempted === true && !snapshot.pending && menu.status === 'builtin'
  }
}
