import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  canResumeAiVaultSessionOnTarget,
  getAiVaultResumeWorkspaceExecutionHostId,
  getAiVaultResumeWorkspaceTargetStatus
} from '@/lib/ai-vault-resume-target'
import {
  AI_VAULT_SESSION_DRAG_END_EVENT,
  AI_VAULT_SESSION_DRAG_START_EVENT,
  clearAiVaultSessionDragData,
  hasAiVaultSessionDragData,
  readAiVaultSessionDragData
} from '@/lib/ai-vault-session-drag'
import { getAiVaultAgentProviderSession } from '@/lib/ai-vault-resume-command'
import { buildAiVaultDropLaunchStartup } from '@/lib/ai-vault-drop-resume-startup'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import { aiVaultSessionNeedsResumePreparation } from '@/lib/ai-vault-session-resume-preparation'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { AiVaultPrepareSessionResumeResult } from '../../../../shared/ai-vault-resume-preparation'
import { activateStructuredAgentSessionById } from '@/lib/structured-agent-session-tab-activation'
import {
  containsPoint,
  resolvePaneDropTarget,
  type PaneDropTarget
} from './ai-vault-session-drop-target'

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
      if (payload.structuredSession) {
        const { sessionId, workspaceId } = payload.structuredSession
        if (!activateStructuredAgentSessionById({ worktreeId: workspaceId, sessionId })) {
          toast.error(
            translate(
              'auto.lib.activateAiVaultStructuredSession.unavailable',
              'The structured agent session is not available yet. Retry in a moment.'
            )
          )
        }
        return true
      }

      const state = useAppStore.getState()
      const targetStatus = getAiVaultResumeWorkspaceTargetStatus(state, worktreeId)
      const targetExecutionHostId = getAiVaultResumeWorkspaceExecutionHostId(state, worktreeId)
      if (targetStatus === 'unknown') {
        toast.error(
          translate(
            'auto.components.tab.group.AiVaultSessionDropLayer.openSupportedWorkspace',
            'Open a workspace before resuming a session.'
          )
        )
        return true
      }
      if (
        !canResumeAiVaultSessionOnTarget({
          sessionFilePath: payload.sessionFilePath ?? null,
          sessionExecutionHostId: payload.sessionExecutionHostId ?? null,
          targetStatus,
          targetExecutionHostId
        })
      ) {
        toast.error(
          translate(
            'auto.components.tab.group.AiVaultSessionDropLayer.sessionHostMismatchUnsupported',
            'This session belongs to a different host. Drop it onto a workspace on the same host.'
          )
        )
        return true
      }

      const showQueuedToast = (): void => {
        toast.success(
          translate(
            'auto.components.tab.group.AiVaultSessionDropLayer.sessionQueued',
            'Session queued'
          )
        )
      }
      const preparation =
        payload.sessionFilePath &&
        payload.sessionExecutionHostId &&
        payload.codexHome !== undefined &&
        aiVaultSessionNeedsResumePreparation({
          agent: payload.agent,
          codexHome: payload.codexHome,
          executionHostId: payload.sessionExecutionHostId
        })
          ? window.api.aiVault.prepareSessionResume({
              agent: payload.agent,
              sessionId: payload.sessionId,
              filePath: payload.sessionFilePath,
              executionHostId: payload.sessionExecutionHostId,
              codexHome: payload.codexHome
            })
          : Promise.resolve<AiVaultPrepareSessionResumeResult>({ useRealCodexHome: false })
      void preparation
        .then(async (result) => {
          const startup = await buildAiVaultDropLaunchStartup({
            state: useAppStore.getState(),
            payload,
            useRealCodexHome: result.useRealCodexHome,
            substituteCodexHome: result.substituteCodexHome,
            worktreeId
          })
          if (!startup) {
            // Why: the host just proved the prebuilt command pins another
            // account's home, so an unrepinnable payload (older serializer)
            // must fail loudly rather than silently resume under it.
            throw new Error(
              result.substituteCodexHome
                ? 'This session was dragged from an older Orca window, so Orca cannot retarget it to the selected Codex account. Resume it from the Session History panel instead.'
                : 'Orca could not prepare this legacy Codex session. Retry resume.'
            )
          }
          const startupCwd =
            'cwd' in startup && typeof startup.cwd === 'string' ? startup.cwd : payload.sessionCwd
          const providerSession = getAiVaultAgentProviderSession({
            agent: payload.agent,
            sessionId: payload.sessionId,
            filePath: payload.sessionFilePath
          })
          const launchResult = launchAiVaultSessionInNewTab({
            agent: payload.agent,
            worktreeId,
            command: startup.command,
            ...(startupCwd ? { cwd: startupCwd } : {}),
            ...(startup.env ? { env: startup.env } : {}),
            ...(startup.envToDelete ? { envToDelete: startup.envToDelete } : {}),
            ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {}),
            ...(providerSession ? { providerSession } : {}),
            targetGroupId: dropTarget.groupId,
            splitDirection: dropTarget.zone === 'center' ? undefined : dropTarget.zone
          })
          if (launchResult.tabId === null) {
            void launchResult.runtimeLaunch.then((outcome) => {
              if (outcome.status === 'failed') {
                toast.error(
                  outcome.message ||
                    translate(
                      'auto.lib.launch.agent.in.new.tab.11cce5cc77',
                      'Could not launch {{value0}} in a new terminal.',
                      { value0: payload.agent }
                    )
                )
                return
              }
              showQueuedToast()
            })
            return
          }
          showQueuedToast()
        })
        .catch((error: unknown) => {
          toast.error(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.right.sidebar.AiVaultPanel.prepareSessionResumeFailed',
                  'Could not prepare this session for resume.'
                )
          )
        })
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
