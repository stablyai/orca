import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { editor } from 'monaco-editor'
import { monaco } from '@/lib/monaco-setup'
import {
  disposeUnattachedDiffViewerMonacoModels,
  disposeUnattachedMonacoModelPaths,
  getDiffViewerMonacoModelPaths
} from './diff-monaco-model-disposal'

type DiffViewerLargeDiffLifecycleInput = {
  limited: boolean
  modelKey: string
  originalModelKey?: string
  modifiedModelKey?: string
  diffEditorRef: RefObject<editor.IStandaloneDiffEditor | null>
  onEnterFallback: () => void
}

export function useDiffViewerLargeDiffLifecycle({
  limited,
  modelKey,
  originalModelKey,
  modifiedModelKey,
  diffEditorRef,
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
  const previousDiffModelPathsRef = useRef(currentDiffModelPaths)

  useEffect(() => {
    const previousModelPaths = previousDiffModelPathsRef.current
    previousDiffModelPathsRef.current = currentDiffModelPaths
    const supersededModelPaths = [
      previousModelPaths.originalModelPath !== currentDiffModelPaths.originalModelPath
        ? previousModelPaths.originalModelPath
        : null,
      previousModelPaths.modifiedModelPath !== currentDiffModelPaths.modifiedModelPath
        ? previousModelPaths.modifiedModelPath
        : null
    ].filter((modelPath): modelPath is string => modelPath !== null)
    if (supersededModelPaths.length === 0) {
      return
    }
    const diffEditor = diffEditorRef.current
    if (diffEditor) {
      const originalModel = monaco.editor.getModel(
        monaco.Uri.parse(currentDiffModelPaths.originalModelPath)
      )
      const modifiedModel = monaco.editor.getModel(
        monaco.Uri.parse(currentDiffModelPaths.modifiedModelPath)
      )
      if (!originalModel || !modifiedModel) {
        return
      }
      const activeModels = diffEditor.getModel()
      if (activeModels?.original !== originalModel || activeModels.modified !== modifiedModel) {
        // Why: @monaco-editor/react swaps the two child models separately, but
        // Monaco's diff widget must release its old pair before either is disposed.
        diffEditor.setModel({ original: originalModel, modified: modifiedModel })
      }
    }
    disposeUnattachedMonacoModelPaths(monaco, supersededModelPaths)
  }, [currentDiffModelPaths, diffEditorRef])

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
