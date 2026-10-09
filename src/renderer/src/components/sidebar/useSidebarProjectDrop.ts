import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { hasNativeFileDragTypes } from '../../../../shared/native-file-drop'
import { createOsFileDropSequence, useOsFileDropOwner } from '@/hooks/use-os-file-drop-owner'
import { getNativeFileDropRejectionMessage } from '@/lib/native-file-drop-rejection-message'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import {
  getSidebarProjectDropAffordance,
  isRemoteRuntimeActive,
  resolveSidebarProjectDropPath
} from './sidebar-project-drop'
import { translate } from '@/i18n/i18n'
import { userNamedFileAccess } from '@/lib/local-file-access'

type SidebarProjectDropHandlers = {
  onDragEnter: (event: React.DragEvent<HTMLElement>) => void
  onDragLeave: (event: React.DragEvent<HTMLElement>) => void
}

/** The sidebar owns OS folder drops and offers to add the dropped folder as a project. */
export function useSidebarProjectDrop(): {
  dropOwnerRef: (root: HTMLElement | null) => void
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
        toast.warning(
          translate(
            'auto.components.sidebar.useSidebarProjectDrop.c0315153d1',
            'Drop one folder at a time.'
          )
        )
        return
      }
      // Why: re-read live settings; a runtime can be focused while the drop is prepared.
      if (isRemoteRuntimeActive(useAppStore.getState().settings)) {
        toast.error(
          translate(
            'auto.components.sidebar.useSidebarProjectDrop.849ef13dc0',
            'Local folder drops are unavailable for server runtimes.'
          ),
          {
            description: translate(
              'auto.components.sidebar.useSidebarProjectDrop.5ccb56c7be',
              'Use Add Project to enter a host path.'
            )
          }
        )
        return
      }

      setIsHandlingDrop(true)
      try {
        const stat = await window.api.fs.stat({
          filePath: pathResolution.path,
          access: userNamedFileAccess()
        })
        if (!mountedRef.current) {
          return
        }
        if (!stat.isDirectory) {
          toast.error(
            translate(
              'auto.components.sidebar.useSidebarProjectDrop.451a4638db',
              'Drop a folder to add it as a project.'
            )
          )
          return
        }
        openModal('add-repo', { droppedLocalPath: pathResolution.path })
      } catch (error) {
        if (mountedRef.current) {
          toast.error(
            translate(
              'auto.components.sidebar.useSidebarProjectDrop.f34a286c0d',
              'Could not add dropped folder.'
            ),
            {
              description: error instanceof Error ? error.message : String(error)
            }
          )
        }
      } finally {
        if (mountedRef.current) {
          setIsHandlingDrop(false)
        }
      }
    },
    [mountedRef, openModal]
  )

  const ownerRef = useRef<HTMLElement | null>(null)
  const [sequence] = useState(createOsFileDropSequence)
  const dropOwnerRef = useOsFileDropOwner(ownerRef, {
    consumer: 'main-reader',
    sequence,
    // A remote runtime cannot add a local folder, so the drag shows "not allowed".
    canAccept: !remoteRuntimeActive,
    onDrop: async (prepared) => {
      for (const failure of prepared.failures) {
        const message = getNativeFileDropRejectionMessage(failure)
        toast.error(message.title, { description: message.description })
      }
      await handleProjectDropPaths(prepared.paths)
    }
  })

  const dropHandlers = useMemo<SidebarProjectDropHandlers>(
    () => ({
      onDragEnter: (event) => {
        if (!hasNativeFileDragTypes(event.dataTransfer.types)) {
          return
        }
        dragDepthRef.current += 1
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
    []
  )

  return {
    dropOwnerRef,
    dropHandlers,
    affordance: getSidebarProjectDropAffordance({
      isDragOver,
      isHandlingDrop,
      remoteRuntimeActive
    })
  }
}
