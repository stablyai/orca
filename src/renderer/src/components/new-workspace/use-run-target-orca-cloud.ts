import { useCallback } from 'react'
import type { OrcaCloudAvailability } from '../../../../shared/orca-yaml-hook-types'
import { isOrcaCloudRecipe, type EphemeralVmRecipeOption } from './run-target-options'
import {
  orcaCloudBlockedAction,
  useOrcaCloudRunTargetAccess,
  type OrcaCloudRunTargetAccess
} from './orca-cloud-run-target-access'

/**
 * The Orca Cloud row's access when main sent no Orca Cloud recipe: signed-out and unentitled
 * accounts still see the row, to sign in or upgrade. Null means no recipe-less row.
 */
export function getRunTargetOrcaCloudOffer({
  recipes,
  availability,
  override
}: {
  recipes: readonly EphemeralVmRecipeOption[]
  availability: OrcaCloudAvailability
  override: OrcaCloudRunTargetAccess | undefined
}): OrcaCloudRunTargetAccess | null {
  if (recipes.some(isOrcaCloudRecipe)) {
    return null
  }
  switch (availability) {
    case 'needs-sign-in':
      return override ?? { state: 'signed-out' }
    case 'needs-capability':
      return override ?? { state: 'no-plan', lapsed: false }
    case 'offered':
    case 'unavailable':
      return null
  }
}

/** Resolves the row's access and routes picks: a blocked account goes to sign-in, plans or billing. */
export function useRunTargetOrcaCloud({
  recipes,
  offer,
  override,
  open,
  close,
  selectRecipe
}: {
  recipes: readonly EphemeralVmRecipeOption[]
  offer: OrcaCloudRunTargetAccess | null
  override: OrcaCloudRunTargetAccess | undefined
  open: boolean
  close: () => void
  selectRecipe: (recipeId: string) => void
}): {
  access: OrcaCloudRunTargetAccess
  runBlockedAction: () => void
  select: (recipe: EphemeralVmRecipeOption | null) => void
} {
  const fetched = useOrcaCloudRunTargetAccess(open && !override && recipes.some(isOrcaCloudRecipe))
  const access = offer ?? override ?? fetched
  const blocked = orcaCloudBlockedAction(access)
  const runBlockedAction = useCallback((): void => {
    close()
    blocked?.()
  }, [blocked, close])
  // A blocked account would only get a failing build, so route it instead of selecting.
  const select = useCallback(
    (recipe: EphemeralVmRecipeOption | null): void => {
      if (blocked) {
        runBlockedAction()
        return
      }
      if (recipe) {
        selectRecipe(recipe.id)
      }
    },
    [blocked, runBlockedAction, selectRecipe]
  )
  return { access, runBlockedAction, select }
}
