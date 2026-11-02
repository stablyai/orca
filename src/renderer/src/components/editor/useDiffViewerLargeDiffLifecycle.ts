import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { editor } from 'monaco-editor'
import { monaco } from '@/lib/monaco-setup'
import {
  disposeUnattachedDiffViewerMonacoModels,
  disposeUnattachedMonacoModelPaths,
  getDiffViewerMonacoModelPaths,
  recallDiffViewerModelPaths,
  rememberDiffViewerModelPaths
} from './diff-monaco-model-disposal'

type DiffViewerLargeDiffLifecycleInput = {
  limited: boolean
  modelKey: string
  modelOwnerKey?: string
  originalModelKey?: string
  modifiedModelKey?: string
  diffEditorRef: RefObject<editor.IStandaloneDiffEditor | null>
  onEnterFallback: () => void
}

export function useDiffViewerLargeDiffLifecycle({
  limited,
  modelKey,
  modelOwnerKey,
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
        modelOwnerKey,
        originalModelKey,
        modifiedModelKey,
        generationSuffix: largeDiffModelGenerationSuffix
      }),
    [modelKey, modelOwnerKey, originalModelKey, modifiedModelKey, largeDiffModelGenerationSuffix]
  )
  const currentDiffModelPathsRef = useRef(currentDiffModelPaths)
  currentDiffModelPathsRef.current = currentDiffModelPaths
  const previousDiffModelPathsRef = useRef<typeof currentDiffModelPaths | null>(null)

  useEffect(() => {
    const previousModelPaths =
      previousDiffModelPathsRef.current ??
      (modelOwnerKey ? recallDiffViewerModelPaths(modelOwnerKey, modelKey) : undefined) ??
      currentDiffModelPaths
    previousDiffModelPathsRef.current = currentDiffModelPaths
    if (modelOwnerKey) {
      rememberDiffViewerModelPaths(modelOwnerKey, modelKey, currentDiffModelPaths)
    }
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
        // Release the diff widget’s old model pair before the React wrapper disposes either child separately.
        diffEditor.setModel({ original: originalModel, modified: modifiedModel })
      }
    }
    disposeUnattachedMonacoModelPaths(monaco, supersededModelPaths)
  }, [currentDiffModelPaths, diffEditorRef, modelKey, modelOwnerKey])

  useEffect(() => {
    if (!limited) {
      return
    }
    const modelPathsToDispose = currentDiffModelPathsRef.current
    // Rotate paths after fallback so a shrinking diff cannot reuse its old oversized model.
    setLargeDiffModelGeneration((generation) => generation + 1)
    onEnterFallback()
    // Fallback must release huge retained models after unmount cleanup, unlike ordinary tab switching.
    const disposeTimer = window.setTimeout(() => {
      disposeUnattachedDiffViewerMonacoModels(monaco, modelPathsToDispose)
    }, 0)
    return () => window.clearTimeout(disposeTimer)
  }, [limited, onEnterFallback])

  return currentDiffModelPaths
}
