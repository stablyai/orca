import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { OrchestrationCrewSnapshot } from '../../../../shared/orchestration-crew'
import { observeCrew } from '../orchestration-crew/orchestration-crew-follow'
import { UNKNOWN_CREW } from '../orchestration-crew/orchestration-crew-subscription'

export function useOrchestrationCrew(
  target: RuntimeClientTarget | null,
  party: string | null
): OrchestrationCrewSnapshot {
  const kind = target?.kind
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const entry = useMemo(() => {
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
    (listener: () => void) => entry?.subscribe(listener) ?? (() => {}),
    [entry]
  )
  return useSyncExternalStore(subscribe, entry?.read ?? (() => UNKNOWN_CREW))
}
