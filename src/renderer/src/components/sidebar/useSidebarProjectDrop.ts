import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  NATIVE_FILE_DROP_TARGET,
  hasNativeFileDragTypes
} from '../../../../shared/native-file-drop'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import {
  getSidebarProjectDropAffordance,
  isRemoteRuntimeActive,
  resolveSidebarProjectDropPath
} from './sidebar-project-drop'

type SidebarProjectDropHandlers = {
  onDragEnter: (event: React.DragEvent<HTMLElement>) => void
  onDragOver: (event: React.DragEvent<HTMLElement>) => void
  onDragLeave: (event: React.DragEvent<HTMLElement>) => void
}

export function useSidebarProjectDrop(): {
  nativeDropTarget: typeof NATIVE_FILE_DROP_TARGET.projectSidebar
  dropHandlers: SidebarProjectDropHandlers
  affordance: ReturnType<typeof getSidebarProjectDropAffordance>
} {
  const openModal = useAppStore((s) => s.openModal)
  const settings = useAppStore((s) => s.settings)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isHandlingDrop, setIsHandlingDrop] = useState(false)
  const dragDepthRef = useRef(0)
  const remoteRuntimeActive = isRemoteRuntimeActive(settings)
  const mountedRef = useMountedRef()

  const clearDragState = useCallback(() => {
    dragDepthRef.current = 0
    setIsDragOver(false)
  }, [])

  useEffect(() => {
    document.addEventListener('drop', clearDragState, true)
    document.addEventListener('dragend', clearDragState, true)
    return () => {
      document.removeEventListener('drop', clearDragState, true)
      document.removeEventListener('dragend', clearDragState, true)
    }
  }, [clearDragState])

  const handleProjectDropPaths = useCallback(
    async (paths: readonly string[]) => {
      const pathResolution = resolveSidebarProjectDropPath(paths)
      if (pathResolution.status === 'empty') {
        return
      }
      if (pathResolution.status === 'multiple') {
        toast.warning('Drop one folder at a time.')
        return
      }
      if (remoteRuntimeActive) {
        toast.error('Local folder drops are unavailable for server runtimes.', {
          description: 'Use Add Project to enter a server path.'
        })
        return
      }

      setIsHandlingDrop(true)
      try {
        await window.api.fs.authorizeExternalPath({ targetPath: pathResolution.path })
        const stat = await window.api.fs.stat({ filePath: pathResolution.path })
        if (!mountedRef.current) {
          return
        }
        if (!stat.isDirectory) {
          toast.error('Drop a folder to add it as a project.')
          return
        }
        openModal('add-repo', { droppedLocalPath: pathResolution.path })
      } catch (error) {
        if (mountedRef.current) {
          toast.error('Could not add dropped folder.', {
            description: error instanceof Error ? error.message : String(error)
          })
        }
      } finally {
        if (mountedRef.current) {
          setIsHandlingDrop(false)
        }
      }
    },
    [mountedRef, openModal, remoteRuntimeActive]
  )

  useEffect(() => {
    return window.api.ui.onFileDrop((data) => {
      if (data.target !== NATIVE_FILE_DROP_TARGET.projectSidebar) {
        return
      }
      void handleProjectDropPaths(data.paths)
    })
  }, [handleProjectDropPaths])

  const dropHandlers = useMemo<SidebarProjectDropHandlers>(
    () => ({
      onDragEnter: (event) => {
        if (!hasNativeFileDragTypes(event.dataTransfer.types)) {
          return
        }
        dragDepthRef.current += 1
        setIsDragOver(true)
      },
      onDragOver: (event) => {
        if (!hasNativeFileDragTypes(event.dataTransfer.types)) {
          return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = remoteRuntimeActive ? 'none' : 'copy'
        setIsDragOver(true)
      },
      onDragLeave: (event) => {
        if (!hasNativeFileDragTypes(event.dataTransfer.types)) {
          return
        }
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) {
          setIsDragOver(false)
        }
      }
    }),
    [remoteRuntimeActive]
  )

  return {
    nativeDropTarget: NATIVE_FILE_DROP_TARGET.projectSidebar,
    dropHandlers,
    affordance: getSidebarProjectDropAffordance({
      isDragOver,
      isHandlingDrop,
      remoteRuntimeActive
    })
  }
}
