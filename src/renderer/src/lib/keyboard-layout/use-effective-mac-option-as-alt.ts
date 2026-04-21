/**
 * React hook: resolve the user-facing `terminalMacOptionAsAlt` setting
 * (which may be `'auto'`) into the four-valued `EffectiveMacOptionAsAlt`
 * that xterm.js and terminal-shortcut-policy consume.
 *
 * The probe's `current` is held outside React state, so we subscribe inside
 * a useSyncExternalStore to keep every consumer in sync when the OS layout
 * switches mid-session (e.g. user flips Input Source, Orca regains focus,
 * focus-in listener re-probes).
 */
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
