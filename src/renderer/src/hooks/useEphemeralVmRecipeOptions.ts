import { ORCA_CLOUD_RECIPE_ID } from '../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { OrcaCloudAvailability, OrcaVmRecipe } from '../../../shared/orca-yaml-hook-types'
import { useAppStore } from '@/store'
import type { EphemeralVmFailure } from '../../../shared/ephemeral-vm-failure-copy'
import { ephemeralVmErrorText } from '@/runtime/ephemeral-vm/ephemeral-vm-error-copy'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { takeOrcaCloudSelectionAfterSignIn } from '@/lib/orca-cloud-select-after-sign-in'
import { onOrcaCloudCheckoutReturn } from '@/lib/orca-cloud-after-checkout'

type EphemeralVmRecipeOptionsArgs = {
  /** Defaults on: Orca Cloud is gated by the account's sandbox capability in main. */
  enabled?: boolean
  /** Off: only built-in Orca Cloud is offered, and orca.yaml recipe diagnostics stay hidden. */
  customRecipesEnabled: boolean
  repoId: string | null
  repoIsGit: boolean
  repoConnectionId: string | null
  repoExecutionHostId: ExecutionHostId | null
  projectGroupTarget: boolean
  initialRecipeId?: string
}

/** Orca Cloud is shipped but the account isn't ready yet (signed out, or no plan/capability). */
function orcaCloudNeedsSetup(availability: OrcaCloudAvailability | undefined): boolean {
  return availability === 'needs-sign-in' || availability === 'needs-capability'
}

/**
 * Main lists the Orca Cloud recipe only once the account can use it. Until then the composer still
 * offers it, so a signed-out or not-yet-entitled user can pick Orca Cloud and reach "Set up and
 * start" (spec A1/B1); the setup panel runs instead of a create, so this entry never starts a VM.
 */
const ORCA_CLOUD_SETUP_RECIPE: OrcaVmRecipe = {
  id: ORCA_CLOUD_RECIPE_ID,
  name: 'Orca Cloud',
  provider: 'orca-cloud',
  create: 'orca-cloud create'
}

export function withOrcaCloudSetupRecipe(
  recipes: OrcaVmRecipe[],
  availability: OrcaCloudAvailability | undefined,
  /** A plain folder: main lists no recipes for it, but Orca Cloud is still offered (D3). */
  folder = false
): OrcaVmRecipe[] {
  const offeredForFolder = folder && availability === 'offered'
  if (
    !(orcaCloudNeedsSetup(availability) || offeredForFolder) ||
    recipes.some((r) => r.id === ORCA_CLOUD_RECIPE_ID)
  ) {
    return recipes
  }
  return [ORCA_CLOUD_SETUP_RECIPE, ...recipes]
}

export function useEphemeralVmRecipeOptions(args: EphemeralVmRecipeOptionsArgs): {
  recipes: OrcaVmRecipe[]
  selectedRecipeId: string | null
  setSelectedRecipeId: (recipeId: string | null) => void
  error: string | null
  /** Recipes may be picked: custom recipes are on, or the list holds Orca Cloud (all a flag-off list can hold). */
  offered: boolean
  /** Orca Cloud for this target as main reports it; `unavailable` where recipe VMs can't run. */
  orcaCloud: OrcaCloudAvailability
} {
  const [recipes, setRecipes] = useState<OrcaVmRecipe[]>([])
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null)
  // Failures stay coded until render so a language switch relocalizes them.
  const [errors, setErrors] = useState<EphemeralVmFailure[]>([])
  const [orcaCloud, setOrcaCloud] = useState<OrcaCloudAvailability>('unavailable')
  const requestGeneration = useRef(0)
  // A plain folder still loads: it offers Orca Cloud only, and the setup panel then says the
  // project needs a GitHub repository (D3/D4) instead of the option vanishing.
  // RUNON-NO-NEW-SANDBOX: a project cloned only on a remote Orca server (a paired cloud workspace's)
  // still offers Orca Cloud; like a folder it has no recipes here and starts from GitHub (D4).
  const remoteServer =
    !args.repoConnectionId && parseExecutionHostId(args.repoExecutionHostId)?.kind === 'runtime'
  const canLoad =
    args.enabled !== false &&
    Boolean(args.repoId) &&
    !args.repoConnectionId &&
    (args.repoExecutionHostId === LOCAL_EXECUTION_HOST_ID || remoteServer) &&
    !args.projectGroupTarget

  const load = useCallback(
    (resetSelection: boolean): void => {
      const generation = ++requestGeneration.current
      if (resetSelection) {
        setRecipes([])
        setSelectedRecipeId(null)
        setErrors([])
      }
      if (!canLoad || !args.repoId) {
        return
      }
      const repoId = args.repoId
      // Orca Cloud loads recipes even with VM recipes off, so a window without the VM bridge
      // (detached roots, tests) must land in .catch, not throw from render.
      void Promise.resolve()
        .then(() => window.api.ephemeralVm.listRecipes({ repoId }))
        .then((result) => {
          if (generation !== requestGeneration.current) {
            return
          }
          // Orca Cloud rides its account capability, not the experimental VM-recipes flag.
          const nextRecipes = withOrcaCloudSetupRecipe(
            remoteServer
              ? []
              : (result.recipes ?? []).filter(
                  (recipe) =>
                    recipe.provider === 'orca-cloud' ||
                    (args.customRecipesEnabled && args.repoIsGit)
                ),
            result.orcaCloud,
            !args.repoIsGit || remoteServer
          )
          setRecipes(nextRecipes)
          setOrcaCloud(result.orcaCloud ?? 'unavailable')
          // Why outside the updater: StrictMode runs updaters twice and keeps the second result, so
          // consuming the one-time intent inside it would always lose the selection.
          const afterSignIn = resetSelection ? null : takeOrcaCloudSelectionAfterSignIn(nextRecipes)
          // Orca Cloud stays picked while the account still needs setup: the composer's setup panel
          // says what's missing instead of the pick silently falling back to this computer.
          const keeps = (recipeId: string): boolean =>
            nextRecipes.some((recipe) => recipe.id === recipeId)
          setSelectedRecipeId((current) => {
            if (resetSelection) {
              return args.initialRecipeId && keeps(args.initialRecipeId)
                ? args.initialRecipeId
                : null
            }
            if (afterSignIn) {
              return afterSignIn
            }
            return current && keeps(current) ? current : null
          })
          const diagnosticMessages = (result.diagnostics ?? []).map((diagnostic) => {
            const recipeLabel = `environmentRecipes[${diagnostic.index}]`
            const fieldLabel = diagnostic.field ? `.${diagnostic.field}` : ''
            return { error: `${recipeLabel}${fieldLabel}: ${diagnostic.message}` }
          })
          if (!args.customRecipesEnabled || !args.repoIsGit || remoteServer) {
            setErrors([])
            return
          }
          setErrors([
            ...(result.status === 'error' && result.message
              ? [
                  {
                    error: result.message,
                    errorCode: result.messageCode,
                    errorParams: result.messageParams
                  }
                ]
              : []),
            ...diagnosticMessages
          ])
        })
        .catch((cause) => {
          if (generation !== requestGeneration.current) {
            return
          }
          setRecipes([])
          setSelectedRecipeId(null)
          setErrors(
            args.customRecipesEnabled
              ? [{ error: cause instanceof Error ? cause.message : String(cause) }]
              : []
          )
        })
    },
    [
      args.customRecipesEnabled,
      args.initialRecipeId,
      args.repoId,
      args.repoIsGit,
      canLoad,
      remoteServer
    ]
  )

  useEffect(() => {
    load(true)
    return () => {
      requestGeneration.current += 1
    }
  }, [load])

  // Signing in or out, or a capability change, adds or drops the Orca Cloud recipe in main.
  const authKey = useAppStore((state) => {
    const status = state.orcaProfileAuthStatus
    return `${status?.state ?? 'none'}:${status?.capabilities?.flags.sandbox === true}`
  })
  const lastAuthKey = useRef(authKey)
  useEffect(() => {
    if (lastAuthKey.current === authKey) {
      return
    }
    lastAuthKey.current = authKey
    load(false)
  }, [authKey, load])

  // A paid Checkout from the Run-on row: reload so the left selection intent picks Orca Cloud.
  useEffect(() => onOrcaCloudCheckoutReturn(() => load(false)), [load])

  useEffect(() => {
    if (!window.api.plugins?.onChanged) {
      return
    }
    return window.api.plugins.onChanged((event) => {
      if (event?.contentPacksChanged ?? true) {
        load(false)
      }
    })
  }, [load])

  useUiLanguageRevision()
  const error = errors.map(ephemeralVmErrorText).filter(Boolean).join('\n') || null
  return {
    recipes,
    selectedRecipeId,
    setSelectedRecipeId,
    error,
    offered: (args.customRecipesEnabled && args.repoIsGit) || recipes.length > 0,
    orcaCloud: canLoad ? orcaCloud : 'unavailable'
  }
}
