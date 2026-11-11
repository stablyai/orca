import { useEffect, useEffectEvent, useState } from 'react'
import { useAppStateViewActive } from '@/store/retained-views/app-state-view'
import {
  readModelMenuCatalog,
  type ModelMenuReadScope
} from '@/runtime/native-chat/model-catalogs/model-menu-catalog-read'
import { subscribeModelMenuInvalidation } from '@/runtime/native-chat/model-catalogs/model-menu-invalidation'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import { modelMenuOptions } from '../../../../../shared/agent-session/options/model-menu-options'
import { getAgentSessionOptionLaunchCatalog } from '../../../../../shared/agent-session/options/agent-session-option-catalog'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentDedicatedChoices } from '../../../../../shared/agent-launch/choices/agent-launch-choices'
import { agentPickerCatalogFailure } from '../agent-picker-catalog-jobs'

export type AgentModelMenuSource = { scope: ModelMenuReadScope; coherentCatalog: boolean }
type Display = {
  key: string
  answer?: AgentSessionModelCatalogResult
  outcome?: 'pending' | 'settled' | 'failed' | 'unsupported'
}
function afterFailure(answer: AgentSessionModelCatalogResult | undefined) {
  if (
    !answer ||
    (answer.listingInProgress && (answer.origin === 'unknown' || !answer.models.length))
  ) {
    return undefined
  }
  const { waitExpired: _expired, listingInProgress: _listing, ...held } = answer
  return held
}

export function useAgentModelMenu(
  agent: TuiAgent,
  saved: AgentDedicatedChoices | undefined,
  source: AgentModelMenuSource | undefined,
  open: boolean
) {
  const active = useAppStateViewActive()
  const key = JSON.stringify(source?.scope)
  const [display, setDisplay] = useState<Display>({ key })
  const latestSource = useEffectEvent(() => source)
  useEffect(() => {
    const source = latestSource()
    if (!source) {
      setDisplay((previous) => (previous.key === key ? previous : { key }))
      return
    }
    let cycle: AbortController | undefined
    const read = (invalidate: boolean) => {
      cycle?.abort()
      const controller = new AbortController()
      cycle = controller
      setDisplay((previous) => ({
        key,
        answer: !invalidate && previous.key === key ? previous.answer : undefined,
        outcome:
          open && active
            ? 'pending'
            : !invalidate && previous.key === key && previous.outcome !== 'pending'
              ? previous.outcome
              : undefined
      }))
      if (!open || !active) {
        return
      }
      void (async () => {
        let waited = false
        try {
          while (!controller.signal.aborted) {
            const answer = await readModelMenuCatalog(source.scope, waited, controller.signal)
            if (controller.signal.aborted || !answer) {
              return
            }
            const follow = answer.listingInProgress && (!waited || answer.waitExpired)
            setDisplay({ key, answer, outcome: follow ? 'pending' : 'settled' })
            if (!follow) {
              return
            }
            waited = true
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            setDisplay((previous) => ({
              key,
              answer: afterFailure(previous.key === key ? previous.answer : undefined),
              outcome: agentPickerCatalogFailure(error)
            }))
          }
        }
      })()
    }
    const stop = subscribeModelMenuInvalidation(source.scope.target, () => read(true))
    read(false)
    return () => {
      cycle?.abort()
      stop()
    }
  }, [key, open, active])
  const current = display.key === key ? display : undefined
  const pending = !!source && open && active && (!current?.outcome || current.outcome === 'pending')
  const shown = open && active ? current?.answer : afterFailure(current?.answer)
  const menu = modelMenuOptions(shown, {
    agent,
    surface: 'terminal',
    seed: getAgentSessionOptionLaunchCatalog(agent) ?? { models: [], modelApply: {} },
    pending,
    coherentCatalog: source?.coherentCatalog,
    saved: { ...(saved?.model ? { model: saved.model } : {}), ...saved?.options },
    newLaunch: true,
    seedsModel: false
  })
  const failed = current?.outcome === 'failed' || current?.outcome === 'unsupported'
  return {
    ...menu,
    readOutcome: current?.outcome,
    fallbackAfterFailure: !!source && !pending && failed && menu.status === 'builtin'
  }
}
