import { useEffect, useSyncExternalStore } from 'react'
import { PERSONAL_PROJECT_ORDER_CAPABILITY } from '../../../shared/personal-project-order'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/local-runtime-capabilities'

export function usePersonalProjectOrderSupported(): boolean {
  const observation = useSyncExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation
  )
  useEffect(() => {
    void ensureLocalRuntimeCapabilities()
  }, [])
  return (
    observation.state === 'known' &&
    observation.capabilities.includes(PERSONAL_PROJECT_ORDER_CAPABILITY)
  )
}
