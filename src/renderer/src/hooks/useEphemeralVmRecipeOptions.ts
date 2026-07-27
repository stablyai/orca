import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrcaVmRecipe } from '../../../shared/types'

type EphemeralVmRecipeOptionsArgs = {
  enabled: boolean
  repoId: string | null
  repoIsGit: boolean
  repoConnectionId: string | null
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
  const [error, setError] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const canLoad =
    args.enabled &&
    Boolean(args.repoId) &&
    args.repoIsGit &&
    !args.repoConnectionId &&
    !args.projectGroupTarget

  const load = useCallback(
    (resetSelection: boolean): void => {
      const generation = ++requestGeneration.current
      if (resetSelection) {
        setRecipes([])
        setSelectedRecipeId(null)
        setError(null)
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
            return `${recipeLabel}${fieldLabel}: ${diagnostic.message}`
          })
          setError(
            [result.status === 'error' ? result.message : null, ...diagnosticMessages]
              .filter((message): message is string => Boolean(message))
              .join('\n') || null
          )
        })
        .catch((cause) => {
          if (generation !== requestGeneration.current) {
            return
          }
          setRecipes([])
          setSelectedRecipeId(null)
          setError(cause instanceof Error ? cause.message : String(cause))
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

  return { recipes, selectedRecipeId, setSelectedRecipeId, error }
}
