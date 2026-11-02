import { useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { EditorToggleValue } from './view-mode/EditorViewToggle'
import { flushEditorFrames, hasEditorFrameFlush } from './save/flush/editor-pending-flush'

export function useEditorViewSwitch(
  activeFile: OpenFile | null,
  activeViewStateId: string | null | undefined
): {
  ownerKey: string
  setApply: (apply: (next: EditorToggleValue) => void) => void
  handleChange: (next: EditorToggleValue) => void
} {
  const ownerIdentity = useAppStore((state) => {
    if (!activeFile) {
      return null
    }

    return JSON.stringify([
      getRuntimeTargetForFileOwner(state, activeFile.worktreeId, activeFile.runtimeEnvironmentId),
      activeFile.worktreeId
    ])
  })
  const ownerKey = JSON.stringify([
    ownerIdentity,
    activeFile?.worktreeId ?? null,
    activeFile?.id ?? null,
    activeViewStateId ?? null
  ])
  const generationRef = useRef(0)
  const applyRef = useRef<(next: EditorToggleValue) => void>(() => {})
  const setApply = useCallback((apply: (next: EditorToggleValue) => void): void => {
    applyRef.current = apply
  }, [])

  useLayoutEffect(() => {
    generationRef.current += 1
    return () => {
      generationRef.current += 1
    }
  }, [ownerKey])

  const handleChange = useCallback(
    (next: EditorToggleValue): void => {
      if (!activeFile || ownerIdentity === null) {
        return
      }
      const { id: fileId, worktreeId } = activeFile
      const generation = ++generationRef.current
      const applyIfCurrent = (): void => {
        if (generation !== generationRef.current) {
          return
        }
        const state = useAppStore.getState()
        const currentFile = state.openFiles.find((file) => file.id === fileId)
        if (!currentFile || currentFile.worktreeId !== worktreeId) {
          return
        }
        const currentOwnerIdentity = JSON.stringify([
          getRuntimeTargetForFileOwner(
            state,
            currentFile.worktreeId,
            currentFile.runtimeEnvironmentId
          ),
          currentFile.worktreeId
        ])
        if (currentOwnerIdentity === ownerIdentity) {
          applyRef.current(next)
        }
      }

      const state = useAppStore.getState()
      if (!hasEditorFrameFlush(state, fileId)) {
        applyIfCurrent()
        return
      }

      // Why: a custom editor may keep debounced edits in its frame; only a successful handoff can
      // make it safe to unmount that frame for the new view.
      void flushEditorFrames(state, fileId)
        .then((flushed) => {
          if (flushed) {
            applyIfCurrent()
          }
        })
        .catch(() => {})
    },
    [activeFile, ownerIdentity]
  )

  return { ownerKey, setApply, handleChange }
}
