import { useCallback, useEffect, useRef } from 'react'
import { monaco } from '@/lib/monaco-setup'
import { disposeUnattachedMonacoModelPaths } from './diff-monaco-model-disposal'

// Why: virtualized section rows own Monaco model paths for their lifetime;
// dispose on unmount/collapse so remounts do not leak detached models.
export function useDiffSectionModelLifecycle(params: {
  modelPathBase: string
  collapsed: boolean
}): {
  disposeDiffModels: () => void
  setSectionRootNode: (node: HTMLDivElement | null) => void
} {
  const disposeDiffModels = useCallback(() => {
    window.setTimeout(() => {
      disposeUnattachedMonacoModelPaths(monaco, [
        `${params.modelPathBase}:original`,
        `${params.modelPathBase}:modified`
      ])
    }, 0)
  }, [params.modelPathBase])
  const disposeDiffModelsRef = useRef(disposeDiffModels)
  // Keep callback-ref dispose path on the latest disposer without render-time mutation.
  useEffect(() => {
    disposeDiffModelsRef.current = disposeDiffModels
  }, [disposeDiffModels])

  const setSectionRootNode = useCallback((node: HTMLDivElement | null): void => {
    if (node) {
      return
    }
    disposeDiffModelsRef.current()
  }, [])

  useEffect(() => {
    if (params.collapsed) {
      disposeDiffModels()
    }
  }, [disposeDiffModels, params.collapsed])

  return { disposeDiffModels, setSectionRootNode }
}
