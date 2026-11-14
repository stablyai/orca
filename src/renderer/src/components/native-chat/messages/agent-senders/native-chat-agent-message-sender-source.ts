import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useAppStateView } from '@/store/retained-views/app-state-view'
import type { AppState } from '@/store/types'
import { agentRowDisplayDotState } from '@/lib/agent-status/presentation/agent-row-dot-state'
import { resolveRowProgramStatus } from '@/lib/program-status/agent-row-presentation'
import {
  agentMessageSenderView,
  type AgentMessageSenderView
} from '../../../../../../shared/agent-session/agent-message-presentation'

const EMPTY_VIEW: AgentMessageSenderView = Object.freeze({})
let rowBuilds = 0
/** Counts addressed sender presentations built for owning render tests. */
export const agentMessageSenderRowBuildsForTest = () => rowBuilds
export type SenderLocation = {
  /** A fallback endpoint supplies its kind, never an earlier actor's activity. */
  activity?: false
  host: string
  worktreeId: string
  paneKey: string
  agentType?: AgentMessageSenderView['agentType']
}
type LocateSender = (state: AppState) => SenderLocation | undefined
export type SenderLookup = {
  locate: LocateSender
  savedAgent?: AgentMessageSenderView['agentType']
  leaseLocate?: LocateSender
}

function equalView(a: AgentMessageSenderView, b: AgentMessageSenderView): boolean {
  return a.agentType === b.agentType && a.dot === b.dot && a.progress === b.progress
}

const senderViews = new WeakMap<
  NonNullable<ReturnType<AppState['agentStatusByPaneKey']['projection']['row']>>,
  AgentMessageSenderView
>()

/** Sender badges read the same addressed presentation as the workspace card. */
export function readAgentMessageSenderRow(
  state: AppState,
  location: SenderLocation
): AgentMessageSenderView | undefined {
  const row = state.agentStatusByPaneKey.projection.row(location.paneKey)
  if (!row || row.tab.worktreeId !== location.worktreeId) {
    return undefined
  }
  let view = senderViews.get(row)
  if (!view) {
    const { presentation, dotStateOverride } = resolveRowProgramStatus(row)
    view = {
      agentType: row.agentType,
      dot: dotStateOverride ?? agentRowDisplayDotState(row),
      progress: presentation.progress
    }
    senderViews.set(row, view)
    rowBuilds++
  }
  return view
}

function senderRowView(
  state: AppState,
  location: SenderLocation
): AgentMessageSenderView | undefined {
  const row = readAgentMessageSenderRow(state, location)
  return location.activity === false ? { agentType: row?.agentType ?? location.agentType } : row
}

/** Saved identity leads the live presentation; candidate rows also invalidate a vetoed sender. */
export function useAgentMessageSenderSource(
  locate: LocateSender,
  savedAgent?: AgentMessageSenderView['agentType'],
  leaseLocate: LocateSender = locate
): AgentMessageSenderView {
  const selected = useMemo(() => {
    let previous = EMPTY_VIEW
    return (state: AppState) => {
      const location = locate(state)
      const next = agentMessageSenderView(
        location ? senderRowView(state, location) : undefined,
        savedAgent ?? location?.agentType
      )
      if (!equalView(previous, next)) {
        previous = next
      }
      return previous
    }
  }, [locate, savedAgent])
  return useLeasedSenderSelector(leaseLocate, selected)
}

/** Location changes and the addressed row are both part of the selected value. */
export function useLeasedSenderSelector<T>(
  locate: LocateSender | readonly LocateSender[],
  select: (state: AppState) => T
): T {
  const store = useAppStateView()
  const subscribe = useCallback(
    (notify: () => void) => {
      const projection = store.getState().agentStatusByPaneKey.projection
      let value = select(store.getState())
      const stops = new Map<string, () => void>()
      const refresh = () => {
        const state = store.getState()
        const locators = typeof locate === 'function' ? [locate] : locate
        const keys = new Set(
          locators.flatMap((locator) => {
            const location = locator(state)
            return location ? [location.paneKey] : []
          })
        )
        for (const [key, stop] of stops) {
          if (!keys.has(key)) {
            stop()
            stops.delete(key)
          }
        }
        for (const key of keys) {
          if (!stops.has(key)) {
            stops.set(key, projection.subscribe(`row\0${key}`, refresh))
          }
        }
        const next = select(state)
        if (next !== value) {
          value = next
          notify()
        }
      }
      refresh()
      const stopLocations = projection.subscribe('sender-locations', refresh)
      return () => {
        stopLocations()
        for (const stop of stops.values()) {
          stop()
        }
      }
    },
    [store, locate, select]
  )
  const getSnapshot = useCallback(() => select(store.getState()), [store, select])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useAgentMessageSenderSources(
  lookups: readonly SenderLookup[]
): readonly AgentMessageSenderView[] {
  const selected = useMemo(() => {
    let previous: readonly AgentMessageSenderView[] = []
    return (state: AppState) => {
      let changed = previous.length !== lookups.length
      const next = lookups.map(({ locate, savedAgent }, index) => {
        const location = locate(state)
        const view = agentMessageSenderView(
          location ? senderRowView(state, location) : undefined,
          savedAgent ?? location?.agentType
        )
        const prior = previous[index]
        if (prior && equalView(prior, view)) {
          return prior
        }
        changed = true
        return view
      })
      if (changed) {
        previous = next
      }
      return previous
    }
  }, [lookups])
  const locators = useMemo(
    () => lookups.map((lookup) => lookup.leaseLocate ?? lookup.locate),
    [lookups]
  )
  return useLeasedSenderSelector(locators, selected)
}
