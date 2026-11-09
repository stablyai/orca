import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrcaCloudAvailability } from '../../../../shared/orca-yaml-hook-types'
import { isOrcaCloudRecipe, type EphemeralVmRecipeOption } from './run-target-options'
import { getOrcaCloudPick, type OrcaCloudRunTargetAccess } from './orca-cloud-run-target-access'
import {
  invalidateOrcaCloudBilling,
  useOrcaCloudRunTargetAccess,
  waitForOrcaCloudAccess
} from './orca-cloud-billing-cache'

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

/** How long a pick waits for the first billing answer before proceeding as `unknown`. */
const PICK_WAIT_MS = 1_000

/**
 * Resolves the row's access from the shared billing read (prefetched on mount, so the row rarely
 * shows a skeleton) and routes picks: blocked accounts go to the fix, members' picks do nothing, and
 * a pick made while billing is still loading waits up to PICK_WAIT_MS for the answer.
 */
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
  /** A held pick lands only if the picker is still open (no other pick, Escape or unmount since). */
  open: boolean
  close: () => void
  selectRecipe: (recipeId: string) => void
}): {
  access: OrcaCloudRunTargetAccess
  /** A pick is waiting on billing; the row shows busy. */
  pending: boolean
  runBlockedAction: () => void
  select: (recipe: EphemeralVmRecipeOption | null) => void
} {
  const fetched = useOrcaCloudRunTargetAccess(!override && recipes.some(isOrcaCloudRecipe))
  const access = offer ?? override ?? fetched
  const [pending, setPending] = useState(false)
  const pickToken = useRef(0)
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
    if (!open) {
      // Closing (another pick, Escape, outside click) abandons a held pick.
      pickToken.current += 1
      setPending(false)
    }
  }, [open])
  useEffect(
    () => () => {
      pickToken.current += 1
    },
    []
  )
  const pickFor = useCallback(
    (resolved: OrcaCloudRunTargetAccess, recipe: EphemeralVmRecipeOption | null): void => {
      const pick = getOrcaCloudPick(resolved)
      if (pick.kind === 'act') {
        close()
        // The fix finishes elsewhere (plans, portal, settings): reread billing on return.
        invalidateOrcaCloudBilling({ refetchNow: false })
        pick.run()
      } else if (pick.kind === 'select' && recipe) {
        selectRecipe(recipe.id)
      }
    },
    [close, selectRecipe]
  )
  const runBlockedAction = useCallback((): void => pickFor(access, null), [access, pickFor])
  const select = useCallback(
    (recipe: EphemeralVmRecipeOption | null): void => {
      if (access.state !== 'loading') {
        pickFor(access, recipe)
        return
      }
      const token = ++pickToken.current
      setPending(true)
      void waitForOrcaCloudAccess(PICK_WAIT_MS).then((resolved) => {
        if (token !== pickToken.current || !openRef.current) {
          return
        }
        setPending(false)
        pickFor(resolved, recipe)
      })
    },
    [access, pickFor]
  )
  return { access, pending, runBlockedAction, select }
}
