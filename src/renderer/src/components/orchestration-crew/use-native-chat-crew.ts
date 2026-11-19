import {
  createContext,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type RefObject
} from 'react'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../shared/agent-session/identity/orca-session-address'
import type {
  OrchestrationCrewRow,
  OrchestrationCrewSnapshot,
  OrchestrationCrewSummary
} from '../../../../shared/orchestration/orchestration-crew'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { NativeChatComposerHandle } from '../native-chat/composer/native-chat-composer-types'
import { observeCrew } from './orchestration-crew-follow'
import { UNKNOWN_CREW_STATE, type CrewState } from './orchestration-crew-subscription'

/** A crew row picked to mention, with the agent logo its pill shows. */
export type CrewMention = { row: OrchestrationCrewRow; agentType: string }

/** This chat's crew subscription, stable while the chat stays the same: readers subscribe to what they show. */
export type NativeChatCrewSource = {
  target: RuntimeClientTarget
  canMention: boolean
  subscribe: (listener: () => void) => () => void
  read: () => CrewState
  /** Hold while rows are shown (an open list, an open `@` menu); returns the release. */
  wantRows: () => () => void
  mention: (mentions: readonly CrewMention[]) => void
  /** Puts a name in the message as plain text at the caret, for a subagent, which has no address. */
  insertName: (name: string) => void
}

/** The strip's view of the crew once it has agents: counts, and rows while a reader holds `wantRows`. */
export type NativeChatCrew = NativeChatCrewSource & {
  summary: OrchestrationCrewSummary
  rows: OrchestrationCrewSnapshot | null
}

/** The chat's crew source for its strip and `@` menu; null where it follows none. */
export const NativeChatCrewContext = createContext<NativeChatCrewSource | null>(null)

/** Follows while the chat is visible, like its other strips; splits of one chat share a subscription. */
export function useNativeChatCrewSource({
  target,
  sessionId,
  isVisible,
  composerRef,
  canMention
}: {
  target: RuntimeClientTarget
  sessionId: string
  isVisible: boolean
  composerRef: RefObject<NativeChatComposerHandle | null>
  canMention: boolean
}): NativeChatCrewSource | null {
  const party = isVisible && isOrcaSessionId(sessionId) ? formatOrcaSessionAddress(sessionId) : null
  const kind = target.kind
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const observation = useMemo(() => {
    if (!party) {
      return null
    }
    return kind === 'local'
      ? observeCrew({ kind }, party)
      : environmentId
        ? observeCrew({ kind: 'environment', environmentId }, party)
        : null
  }, [kind, environmentId, party])
  // Rows hold stable functions, so their memo survives the host's re-renders.
  const latest = useRef({ composerRef, hostKey: environmentId ?? 'local' })
  useLayoutEffect(() => {
    latest.current = { composerRef, hostKey: environmentId ?? 'local' }
  })
  const mention = useCallback((mentions: readonly CrewMention[]) => {
    const { composerRef: ref, hostKey } = latest.current
    ref.current?.insertAgentReferences(
      mentions.flatMap(({ row, agentType }) =>
        row.sendAddress ? [{ label: row.label, address: row.sendAddress, hostKey, agentType }] : []
      )
    )
  }, [])
  const insertName = useCallback((name: string) => {
    latest.current.composerRef.current?.insertTypedText(name, { dictated: true })
  }, [])
  return useMemo(
    () =>
      observation
        ? {
            target: kind === 'local' ? { kind } : { kind, environmentId: environmentId ?? '' },
            canMention,
            subscribe: observation.subscribe,
            read: observation.read,
            wantRows: observation.wantRows,
            mention,
            insertName
          }
        : null,
    [observation, kind, environmentId, canMention, mention, insertName]
  )
}

const NO_SUBSCRIPTION = () => () => {}
const NO_STATE = () => UNKNOWN_CREW_STATE

/** The crew's counts and rows for a reader that shows them; nothing for a null source. */
export function useNativeChatCrewState(source: NativeChatCrewSource | null): CrewState {
  return useSyncExternalStore(source?.subscribe ?? NO_SUBSCRIPTION, source?.read ?? NO_STATE)
}

/** The strip's crew: present once the host reports agents. */
export function useNativeChatCrew(source: NativeChatCrewSource | null): NativeChatCrew | null {
  const state = useNativeChatCrewState(source)
  return useMemo(
    () =>
      source && state.summary.status === 'ok' && state.summary.agents > 0
        ? { ...source, summary: state.summary, rows: state.rows }
        : null,
    [source, state]
  )
}
