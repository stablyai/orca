import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import {
  AI_VAULT_SESSION_DRAG_END_EVENT,
  AI_VAULT_SESSION_DRAG_START_EVENT,
  clearAiVaultSessionDragData,
  hasAiVaultSessionDragData,
  readAiVaultSessionDragData
} from '@/lib/ai-vault-session-drag'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import { resolveDropZone, type TabDropZone } from './useTabDragSplit'
import { translate } from '@/i18n/i18n'

type PaneDropTarget = {
  groupId: string
  zone: TabDropZone
  overlayStyle: CSSProperties
}

function getZoneOverlayStyle(rect: DOMRect, layerRect: DOMRect, zone: TabDropZone): CSSProperties {
  const left = rect.left - layerRect.left
  const top = rect.top - layerRect.top
  const width = rect.width
  const height = rect.height

  switch (zone) {
    case 'up':
      return { left, top, width, height: height / 2 }
    case 'down':
      return { left, top: top + height / 2, width, height: height / 2 }
    case 'left':
      return { left, top, width: width / 2, height }
    case 'right':
      return { left: left + width / 2, top, width: width / 2, height }
    case 'center':
      return { left, top, width, height }
  }
}

function containsPoint(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

function resolvePaneDropTarget(
  worktreeId: string,
  layerRect: DOMRect,
  point: { x: number; y: number }
): PaneDropTarget | null {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>('[data-tab-group-body-id][data-worktree-id]')
  )
  for (const element of elements) {
    if (element.dataset.worktreeId !== worktreeId) {
      continue
    }
    const groupId = element.dataset.tabGroupBodyId
    const rect = element.getBoundingClientRect()
    if (!groupId || rect.width <= 0 || rect.height <= 0 || !containsPoint(rect, point.x, point.y)) {
      continue
    }
    const zone = resolveDropZone(rect, point)
    return {
      groupId,
      zone,
      overlayStyle: getZoneOverlayStyle(rect, layerRect, zone)
    }
  }
  return null
}

export default function AiVaultSessionDropLayer({
  worktreeId,
  enabled
}: {
  worktreeId: string
  enabled: boolean
}): React.JSX.Element {
  const [isDragActive, setIsDragActive] = useState(false)
  const [target, setTarget] = useState<PaneDropTarget | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)

  const clearDragState = useCallback(() => {
    setIsDragActive(false)
    setTarget(null)
    clearAiVaultSessionDragData()
  }, [])

  const updateTarget = useCallback(
    (
      dataTransfer: DataTransfer,
      point: {
        x: number
        y: number
      }
    ): PaneDropTarget | null => {
      if (!hasAiVaultSessionDragData(dataTransfer)) {
        setTarget(null)
        return null
      }
      const layerElement = layerRef.current
      if (!layerElement) {
        setTarget(null)
        return null
      }
      const layerRect = layerElement.getBoundingClientRect()
      const nextTarget = resolvePaneDropTarget(worktreeId, layerRect, {
        x: point.x,
        y: point.y
      })
      setTarget((current) => {
        if (
          current?.groupId === nextTarget?.groupId &&
          current?.zone === nextTarget?.zone &&
          current?.overlayStyle.left === nextTarget?.overlayStyle.left &&
          current?.overlayStyle.top === nextTarget?.overlayStyle.top &&
          current?.overlayStyle.width === nextTarget?.overlayStyle.width &&
          current?.overlayStyle.height === nextTarget?.overlayStyle.height
        ) {
          return current
        }
        return nextTarget
      })
      return nextTarget
    },
    [worktreeId]
  )

  const handleSessionDrop = useCallback(
    (
      dataTransfer: DataTransfer,
      point: {
        x: number
        y: number
      }
    ): boolean => {
      if (!hasAiVaultSessionDragData(dataTransfer)) {
        return false
      }

      const layerRect = layerRef.current?.getBoundingClientRect()
      const wasInsideLayer = layerRect ? containsPoint(layerRect, point.x, point.y) : false
      const dropTarget = updateTarget(dataTransfer, point) ?? target
      const payload = readAiVaultSessionDragData(dataTransfer)
      clearDragState()
      if (!dropTarget) {
        if (wasInsideLayer) {
          toast.error(
            translate(
              'auto.components.tab.group.AiVaultSessionDropLayer.dropOntoTerminalPane',
              'Drop onto a terminal pane to resume this session.'
            )
          )
        }
        return wasInsideLayer
      }
      if (!payload) {
        toast.error(
          translate(
            'auto.components.tab.group.AiVaultSessionDropLayer.couldNotReadPayload',
            'Could not read the session drag payload.'
          )
        )
        return true
      }

      const connectionId = getConnectionId(worktreeId)
      if (connectionId) {
        toast.error(
          translate(
            'auto.components.tab.group.AiVaultSessionDropLayer.localWorkspacesOnly',
            'Resume from history is only available in local workspaces.'
          )
        )
        return true
      }
      if (connectionId === undefined) {
        toast.error(
          translate(
            'auto.components.tab.group.AiVaultSessionDropLayer.openLocalWorkspace',
            'Open a local workspace before resuming a session.'
          )
        )
        return true
      }

      launchAiVaultSessionInNewTab({
        agent: payload.agent,
        worktreeId,
        command: payload.command,
        targetGroupId: dropTarget.groupId,
        splitDirection: dropTarget.zone === 'center' ? undefined : dropTarget.zone
      })
      toast.success(
        translate(
          'auto.components.tab.group.AiVaultSessionDropLayer.sessionQueued',
          'Session queued'
        )
      )
      return true
    },
    [clearDragState, target, updateTarget, worktreeId]
  )

  useEffect(() => {
    if (!enabled) {
      clearDragState()
      return
    }

    const markDragActive = (): void => {
      setIsDragActive(true)
    }

    const markIfVaultDrag = (event: DragEvent): void => {
      if (event.dataTransfer && hasAiVaultSessionDragData(event.dataTransfer)) {
        markDragActive()
      }
    }

    const handleWindowDrop = (event: DragEvent): void => {
      if (!event.dataTransfer || !hasAiVaultSessionDragData(event.dataTransfer)) {
        return
      }
      // Electron sometimes accepts dragover on the overlay but skips React's
      // delegated drop handler; capture keeps the visible target and action in sync.
      if (handleSessionDrop(event.dataTransfer, { x: event.clientX, y: event.clientY })) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('dragenter', markIfVaultDrag, true)
    window.addEventListener('dragover', markIfVaultDrag, true)
    window.addEventListener('drop', handleWindowDrop, true)
    window.addEventListener('drop', clearDragState)
    window.addEventListener('dragend', clearDragState, true)
    window.addEventListener(AI_VAULT_SESSION_DRAG_START_EVENT, markDragActive)
    window.addEventListener(AI_VAULT_SESSION_DRAG_END_EVENT, clearDragState)
    return () => {
      window.removeEventListener('dragenter', markIfVaultDrag, true)
      window.removeEventListener('dragover', markIfVaultDrag, true)
      window.removeEventListener('drop', handleWindowDrop, true)
      window.removeEventListener('drop', clearDragState)
      window.removeEventListener('dragend', clearDragState, true)
      window.removeEventListener(AI_VAULT_SESSION_DRAG_START_EVENT, markDragActive)
      window.removeEventListener(AI_VAULT_SESSION_DRAG_END_EVENT, clearDragState)
    }
  }, [clearDragState, enabled, handleSessionDrop])

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasAiVaultSessionDragData(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      setIsDragActive(true)
      const nextTarget = updateTarget(event.dataTransfer, {
        x: event.clientX,
        y: event.clientY
      })
      event.dataTransfer.dropEffect = nextTarget ? 'copy' : 'none'
    },
    [updateTarget]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasAiVaultSessionDragData(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      handleSessionDrop(event.dataTransfer, {
        x: event.clientX,
        y: event.clientY
      })
    },
    [handleSessionDrop]
  )

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return
    }
    setTarget(null)
  }, [])

  return (
    <div
      ref={layerRef}
      aria-hidden="true"
      data-ai-vault-session-drop-layer="true"
      data-worktree-id={worktreeId}
      className={`absolute inset-0 z-[10000] ${
        isDragActive ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {isDragActive && target ? (
        <div className="tab-drop-overlay absolute" style={target.overlayStyle} />
      ) : null}
    </div>
  )
}
