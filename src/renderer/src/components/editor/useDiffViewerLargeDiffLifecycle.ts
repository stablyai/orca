import { useEffect, useMemo, useRef, useState } from 'react'
import { monaco } from '@/lib/monaco-setup'
import {
  disposeUnattachedDiffViewerMonacoModels,
  getDiffViewerMonacoModelPaths
} from './diff-monaco-model-disposal'

type DiffViewerLargeDiffLifecycleInput = {
  limited: boolean
  modelKey: string
  originalModelKey?: string
  modifiedModelKey?: string
  onEnterFallback: () => void
}

export function useDiffViewerLargeDiffLifecycle({
  limited,
  modelKey,
  originalModelKey,
  modifiedModelKey,
  onEnterFallback
}: DiffViewerLargeDiffLifecycleInput): {
  originalModelPath: string
  modifiedModelPath: string
} {
  const [largeDiffModelGeneration, setLargeDiffModelGeneration] = useState(0)
  const largeDiffModelGenerationSuffix =
    largeDiffModelGeneration === 0 ? '' : `:large-diff-generation:${largeDiffModelGeneration}`
  const currentDiffModelPaths = useMemo(
    () =>
      getDiffViewerMonacoModelPaths({
        modelKey,
        originalModelKey,
        modifiedModelKey,
        generationSuffix: largeDiffModelGenerationSuffix
      }),
    [modelKey, originalModelKey, modifiedModelKey, largeDiffModelGenerationSuffix]
  )
  const currentDiffModelPathsRef = useRef(currentDiffModelPaths)
  currentDiffModelPathsRef.current = currentDiffModelPaths

  useEffect(() => {
    if (!limited) {
      return
    }
    const modelPathsToDispose = currentDiffModelPathsRef.current
    // Why: rotate below-limit Monaco paths after a safety fallback so stale
    // large models cannot be reused when the same diff shrinks back down.
    setLargeDiffModelGeneration((generation) => generation + 1)
    onEnterFallback()
    // Why: ordinary tab switches keep models for fast return; the safety
    // fallback must instead release huge detached models after unmount cleanup.
    const disposeTimer = window.setTimeout(() => {
      disposeUnattachedDiffViewerMonacoModels(monaco, modelPathsToDispose)
    }, 0)
    return () => window.clearTimeout(disposeTimer)
  }, [limited, onEnterFallback])

  return currentDiffModelPaths
}
