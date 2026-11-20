import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useAppStateView } from '@/store/retained-views/app-state-view'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { readingAgentSenders } from '@/runtime/native-chat/agent-senders/agent-sender-index'
import type { AppState } from '@/store/types'
import { agentRowDisplayDotState } from '../../../../../../shared/agent-row-dot-state'
import { resolveRowProgramStatus } from '@/lib/program-status/agent-row-presentation'
import {
  agentMessageSenderView,
  type AgentMessageSenderView
} from '../../../../../../shared/agent-session/view/messages/agent-message-presentation'

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

/** Notified only when an addressed row, a sender answer it read, or tabs and owners change. */
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
        const [{ rows, next }, senders] = readingAgentSenders(() => ({
          rows: locators.flatMap((locator) => {
            const location = locator(state)
            return location ? [`row\0${location.paneKey}`] : []
          }),
          next: select(state)
        }))
        const channels = new Set(['sender-locations', ...rows, ...senders])
        for (const [channel, stop] of stops) {
          if (!channels.has(channel)) {
            stop()
            stops.delete(channel)
          }
        }
        for (const channel of channels) {
          if (!stops.has(channel)) {
            stops.set(channel, projection.subscribe(channel, refresh))
          }
        }
        if (next !== value) {
          value = next
          notify()
        }
      }
      refresh()
      return () => {
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

/** The card's runtime target, stable across renders that rebuild an equal one. */
export function useStableSenderTarget(
  target: RuntimeClientTarget | undefined
): RuntimeClientTarget | undefined {
  const kind = target?.kind
  const environmentId = target?.kind === 'environment' ? target.environmentId : undefined
  return useMemo<RuntimeClientTarget | undefined>(
    () =>
      kind === 'local'
        ? { kind: 'local' }
        : environmentId !== undefined
          ? { kind: 'environment', environmentId }
          : undefined,
    [kind, environmentId]
  )
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
