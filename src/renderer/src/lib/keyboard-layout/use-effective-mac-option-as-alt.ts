/** Resolve auto to an explicit terminal mode; subscribe to the external probe so all consumers follow live OS layout switches. */
import { useSyncExternalStore } from 'react'
import {
  effectiveMacOptionAsAlt,
  type DetectedLayoutCategory,
  type EffectiveMacOptionAsAlt
} from './detect-option-as-alt'
import { getOptionAsAltProbe } from './option-as-alt-probe'

export function useDetectedOptionAsAlt(): DetectedLayoutCategory {
  const probe = getOptionAsAltProbe()
  return useSyncExternalStore(
    (notify) => probe.subscribe(() => notify()),
    () => probe.getCurrent(),
    () => 'unknown' as const
  )
}

export function useEffectiveMacOptionAsAlt(
  setting: 'auto' | 'true' | 'false' | 'left' | 'right' | undefined
): EffectiveMacOptionAsAlt {
  const detected = useDetectedOptionAsAlt()
  return effectiveMacOptionAsAlt(setting ?? 'auto', detected)
}
