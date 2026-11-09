import { useCallback, useEffect, useRef, useState } from 'react'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { OrcaCloudAvailability, OrcaVmRecipe } from '../../../shared/orca-yaml-hook-types'
import { useAppStore } from '@/store'
import type { EphemeralVmFailure } from '../../../shared/ephemeral-vm-failure-copy'
import { ephemeralVmErrorText } from '@/lib/ephemeral-vm-error-copy'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

type EphemeralVmRecipeOptionsArgs = {
  enabled: boolean
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
  const canLoad =
    args.enabled &&
    Boolean(args.repoId) &&
    args.repoIsGit &&
    !args.repoConnectionId &&
    args.repoExecutionHostId === LOCAL_EXECUTION_HOST_ID &&
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
      void window.api.ephemeralVm
        .listRecipes({ repoId: args.repoId })
        .then((result) => {
          if (generation !== requestGeneration.current) {
            return
          }
          // Orca Cloud rides its account capability, not the experimental VM-recipes flag.
          const nextRecipes = (result.recipes ?? []).filter(
            (recipe) => args.customRecipesEnabled || recipe.provider === 'orca-cloud'
          )
          setRecipes(nextRecipes)
          setOrcaCloud(result.orcaCloud ?? 'unavailable')
          setSelectedRecipeId((current) => {
            if (resetSelection) {
              return args.initialRecipeId &&
                nextRecipes.some((recipe) => recipe.id === args.initialRecipeId)
                ? args.initialRecipeId
                : null
            }
            return current && nextRecipes.some((recipe) => recipe.id === current) ? current : null
          })
          const diagnosticMessages = (result.diagnostics ?? []).map((diagnostic) => {
            const recipeLabel = `environmentRecipes[${diagnostic.index}]`
            const fieldLabel = diagnostic.field ? `.${diagnostic.field}` : ''
            return { error: `${recipeLabel}${fieldLabel}: ${diagnostic.message}` }
          })
          if (!args.customRecipesEnabled) {
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
    [args.customRecipesEnabled, args.initialRecipeId, args.repoId, canLoad]
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
    offered: args.customRecipesEnabled || recipes.length > 0,
    orcaCloud: canLoad ? orcaCloud : 'unavailable'
  }
}
