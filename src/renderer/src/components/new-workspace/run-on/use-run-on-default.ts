// The target a new composer opens on: This computer until Orca Cloud has started once,
// then each project's last successful target. Applied once per project, never over a user's pick,
// and never to a blocked Orca Cloud.
import { useCallback, useEffect, useRef } from 'react'
import { readRunOnMemory } from '@/lib/orca-cloud/run-on-memory'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import type { OrcaCloudAvailability } from '../../../../../shared/workspace-setup/orca-yaml-hook-types'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import { getOrcaCloudSegmentState, resolveDefaultRunOn } from './cloud-start-model'

export function useRunOnDefault({
  active,
  availability,
  access,
  profileId,
  repoId,
  cloudSelected,
  setRecipeId,
  initialTargetFixed
}: {
  active: boolean
  availability: OrcaCloudAvailability
  access: OrcaCloudRunTargetAccess
  profileId: string | null
  repoId: string
  cloudSelected: boolean
  setRecipeId: ((recipeId: string | null) => void) | undefined
  /** Opened on an explicit target (Landing card, a recovery): memory must not override it. */
  initialTargetFixed: boolean
}): { markTouched: () => void } {
  const segment = getOrcaCloudSegmentState(availability)
  const touchedRef = useRef(initialTargetFixed)
  const appliedForRepo = useRef<string | null>(null)
  useEffect(() => {
    if (!active || touchedRef.current || appliedForRepo.current === repoId || !repoId) {
      return
    }
    if (segment === 'enabled' && access.state === 'loading') {
      return
    }
    appliedForRepo.current = repoId
    const { target } = resolveDefaultRunOn({
      ...readRunOnMemory(profileId, repoId),
      cloudUsable:
        segment === 'enabled' && availability === 'offered' && access.state === 'entitled'
    })
    if (target === 'orca-cloud' && !cloudSelected) {
      setRecipeId?.(ORCA_CLOUD_RECIPE_ID)
    }
  }, [access.state, active, availability, cloudSelected, profileId, repoId, segment, setRecipeId])
  const markTouched = useCallback(() => {
    touchedRef.current = true
  }, [])
  return { markTouched }
}
