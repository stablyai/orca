import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  emptyCrew,
  type OrchestrationCrewSnapshot
} from '../../../../shared/orchestration/orchestration-crew'
import { observeCrew, type CrewObservation } from './orchestration-crew-follow'
import { UNKNOWN_CREW, UNKNOWN_CREW_STATE, type CrewState } from './orchestration-crew-subscription'

/** One crew subscription for this party, or none while `party` is null (hidden or unfocused). */
export function useOrchestrationCrewState(
  target: RuntimeClientTarget | null,
  party: string | null
): { state: CrewState; observation: CrewObservation | null } {
  const kind = target?.kind
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const observation = useMemo(() => {
    if (!party) {
      return null
    }
    if (kind === 'local') {
      return observeCrew({ kind }, party)
    }
    return kind === 'environment' && environmentId
      ? observeCrew({ kind, environmentId }, party)
      : null
  }, [kind, environmentId, party])
  const subscribe = useCallback(
    (listener: () => void) => observation?.subscribe(listener) ?? (() => {}),
    [observation]
  )
  const state = useSyncExternalStore(subscribe, observation?.read ?? (() => UNKNOWN_CREW_STATE))
  return { state, observation }
}

const NO_CREW = emptyCrew('ok')

/** Rows for every reader: the suspended terminal panel always lists them. */
export function useOrchestrationCrew(
  target: RuntimeClientTarget | null,
  party: string | null
): OrchestrationCrewSnapshot {
  const { state, observation } = useOrchestrationCrewState(target, party)
  useEffect(() => observation?.wantRows(), [observation])
  return state.rows ?? (state.summary.status === 'ok' ? NO_CREW : UNKNOWN_CREW)
}
