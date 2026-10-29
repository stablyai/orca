import { useCallback, useEffect, useRef, useState } from 'react'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { OrcaVmRecipe } from '../../../shared/orca-yaml-hook-types'
import type { EphemeralVmFailure } from '../../../shared/ephemeral-vm-failure-copy'
import { ephemeralVmErrorText } from '@/lib/ephemeral-vm-error-copy'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

type EphemeralVmRecipeOptionsArgs = {
  enabled: boolean
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
} {
  const [recipes, setRecipes] = useState<OrcaVmRecipe[]>([])
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null)
  // Failures stay coded until render so a language switch relocalizes them.
  const [errors, setErrors] = useState<EphemeralVmFailure[]>([])
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
          const nextRecipes = result.recipes ?? []
          setRecipes(nextRecipes)
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
          setErrors([{ error: cause instanceof Error ? cause.message : String(cause) }])
        })
    },
    [args.initialRecipeId, args.repoId, canLoad]
  )

  useEffect(() => {
    load(true)
    return () => {
      requestGeneration.current += 1
    }
  }, [load])

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
  return { recipes, selectedRecipeId, setSelectedRecipeId, error }
}
