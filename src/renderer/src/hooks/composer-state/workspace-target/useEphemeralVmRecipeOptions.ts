import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type { OrcaVmRecipe } from '../../../../../shared/workspace-setup/orca-yaml-hook-types'
import type { EphemeralVmFailure } from '../../../../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-failure-copy'
import { ephemeralVmErrorText } from '@/runtime/ephemeral-vm/ephemeral-vm-error-copy'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { takeOrcaCloudSelectionAfterSignIn } from '@/lib/orca-cloud-select-after-sign-in'
import {
  isRemoteServerRepo,
  offeredRecipes,
  orcaCloudDropReasonAfterLoad,
  showsRecipeDiagnostics,
  useOrcaCloudRecipeState,
  useOrcaCloudRecipeView,
  useReloadOnOrcaCloudAuthChange,
  type OrcaCloudRecipeOptions
} from '../../ephemeral-vm-recipe-options-cloud'

export {
  withOrcaCloudSetupRecipe,
  type OrcaCloudDropReason
} from '../../ephemeral-vm-recipe-options-cloud'

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

export function useEphemeralVmRecipeOptions(args: EphemeralVmRecipeOptionsArgs): {
  recipes: OrcaVmRecipe[]
  selectedRecipeId: string | null
  setSelectedRecipeId: (recipeId: string | null) => void
  error: string | null
} & OrcaCloudRecipeOptions {
  const [recipes, setRecipes] = useState<OrcaVmRecipe[]>([])
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null)
  const {
    orcaCloud,
    setOrcaCloud,
    orcaCloudDropped,
    setOrcaCloudDropped,
    selectedRef,
    pickRecipe
  } = useOrcaCloudRecipeState(selectedRecipeId, setSelectedRecipeId)
  // Failures stay coded until render so a language switch relocalizes them.
  const [errors, setErrors] = useState<EphemeralVmFailure[]>([])
  const requestGeneration = useRef(0)
  const remoteServer = isRemoteServerRepo(args.repoConnectionId, args.repoExecutionHostId)
  const canLoad =
    args.enabled !== false &&
    Boolean(args.repoId) &&
    !args.repoConnectionId &&
    (args.repoExecutionHostId === LOCAL_EXECUTION_HOST_ID || remoteServer) &&
    !args.projectGroupTarget

  const load = useCallback(
    (resetSelection: boolean): void => {
      const generation = ++requestGeneration.current
      const scope = {
        customRecipesEnabled: args.customRecipesEnabled,
        repoIsGit: args.repoIsGit,
        remoteServer
      }
      // Orca Cloud isn't tied to a project, so a project change keeps it picked while
      // the new project's options load, and only drops it (saying why) when that project can't use it.
      const carryCloud = resetSelection && selectedRef.current === ORCA_CLOUD_RECIPE_ID
      if (resetSelection) {
        setRecipes((current) =>
          carryCloud ? current.filter((r) => r.id === ORCA_CLOUD_RECIPE_ID) : []
        )
        if (!carryCloud) {
          setSelectedRecipeId(null)
        }
        setOrcaCloudDropped(null)
        setErrors([])
      }
      if (!canLoad || !args.repoId) {
        if (carryCloud && args.repoId) {
          setRecipes([])
          setSelectedRecipeId(null)
          setOrcaCloudDropped(args.enabled === false ? 'unavailable' : 'elsewhere')
        }
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
          const nextRecipes = offeredRecipes(result.recipes, result.orcaCloud, scope)
          setRecipes(nextRecipes)
          setOrcaCloud(result.orcaCloud ?? 'unavailable')
          // Why outside the updater: StrictMode runs updaters twice and keeps the second result, so
          // consuming the one-time intent inside it would always lose the selection.
          const afterSignIn = resetSelection ? null : takeOrcaCloudSelectionAfterSignIn(nextRecipes)
          // Orca Cloud stays picked while the account still needs setup: the composer's setup panel
          // says what's missing instead of the pick silently falling back to this computer.
          const keeps = (recipeId: string): boolean =>
            nextRecipes.some((recipe) => recipe.id === recipeId)
          if (carryCloud && !keeps(ORCA_CLOUD_RECIPE_ID)) {
            setOrcaCloudDropped(orcaCloudDropReasonAfterLoad(result.orcaCloud, remoteServer))
          }
          setSelectedRecipeId((current) => {
            if (resetSelection) {
              if (carryCloud && keeps(ORCA_CLOUD_RECIPE_ID)) {
                return ORCA_CLOUD_RECIPE_ID
              }
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
          if (!showsRecipeDiagnostics(scope)) {
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
          if (carryCloud) {
            setOrcaCloudDropped('unreachable')
          }
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
      args.enabled,
      args.initialRecipeId,
      args.repoId,
      args.repoIsGit,
      canLoad,
      remoteServer,
      selectedRef,
      setOrcaCloud,
      setOrcaCloudDropped
    ]
  )

  useEffect(() => {
    load(true)
    return () => {
      requestGeneration.current += 1
    }
  }, [load])

  useReloadOnOrcaCloudAuthChange(load)

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
  const view = useOrcaCloudRecipeView({
    recipes,
    selectedRecipeId,
    orcaCloud,
    orcaCloudDropped,
    canLoad,
    customRecipesEnabled: args.customRecipesEnabled,
    repoIsGit: args.repoIsGit
  })
  return { ...view, setSelectedRecipeId: pickRecipe, error }
}
