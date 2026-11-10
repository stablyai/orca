import type { ModelCatalogSource } from '../../../../../shared/agent-session/options/model-catalog-source'
import { useCallback, useEffect } from 'react'
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
  const catalog = source ? hostModelMenuCatalog(source.scope) : undefined
  const subscribe = useCallback(
    (listener: () => void) => (catalog ? catalog.subscribe(listener) : subscribeAbsent()),
    [catalog]
  )
  const getSnapshot = useCallback(() => catalog?.snapshot ?? absent, [catalog])
  const snapshot = useAppViewExternalStore(subscribe, getSnapshot, () => absent)
  useEffect(() => {
    if (catalog && open && active) {
      const controller = new AbortController()
      void catalog.read(source?.source === 'cli', undefined, controller.signal)
      return () => controller.abort()
    }
    return undefined
  }, [catalog, open, active, snapshot.generation, source?.source])
  const menu = modelMenuOptions(snapshot.answer, {
    agent,
    surface: 'terminal',
    seed: getAgentSessionOptionLaunchCatalog(agent) ?? { models: [], modelApply: {} },
    pending:
      !!source && (snapshot.pending || (!snapshot.attempted && snapshot.answer === undefined)),
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
