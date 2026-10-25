import { getAiVaultResumeWorkspaceWslDistro } from '@/lib/ai-vault-resume-shell'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  conversationReferenceDropTarget,
  forwardConversationReferenceDrop
} from '@/lib/conversation-reference-drop-target'
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
import {
  buildAiVaultDropRepinStartup,
  getAiVaultAgentProviderSession
} from '@/lib/ai-vault-resume-command'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import { prepareAiVaultTerminalResumeRequest } from '@/lib/ai-vault-session-resume-preparation'
import { describeAiVaultResumeFailure } from '@/lib/ai-vault-resume-refusal'
import { useAppStore } from '@/store'
import {
  containsPoint,
  resolvePaneDropTarget,
  type PaneDropTarget
} from './ai-vault-pane-drop-target'
import { translate } from '@/i18n/i18n'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'

export default function AiVaultSessionDropLayer({
  worktreeId,
  enabled
}: {
  worktreeId: string
  enabled: boolean
}): React.JSX.Element {
  const [isDragActive, setIsDragActive] = useState(false)
  const [overComposer, setOverComposer] = useState(false)
  const [target, setTarget] = useState<PaneDropTarget | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)

  const clearDragState = useCallback(() => {
    setIsDragActive(false)
    setOverComposer(false)
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
      const composer = conversationReferenceDropTarget(point)
      setOverComposer(composer !== null)
      if (composer) {
        setTarget(null)
        return null
      }
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

      if (conversationReferenceDropTarget(point)) {
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
        // Same row, same reveal as clicking Resume. Activating by id alone cannot reach a chat
        // whose tab is closed, which is the case this drop is most often used for.
        void activateAiVaultStructuredSession(payload)
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
          targetExecutionHostId,
          targetWslDistro: getAiVaultResumeWorkspaceWslDistro(state, worktreeId)
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
      if (!payload.sessionFilePath || !payload.sessionExecutionHostId) {
        toast.error(
          translate(
            'auto.components.tab.group.AiVaultSessionDropLayer.oldPayload',
            'This session was dragged from an older Orca window. Resume it from Session History instead.'
          )
        )
        return true
      }
      const preparation = prepareAiVaultTerminalResumeRequest({
        agent: payload.agent,
        sessionId: payload.sessionId,
        filePath: payload.sessionFilePath,
        executionHostId: payload.sessionExecutionHostId,
        codexHome: payload.codexHome ?? null
      })
      void preparation
        .then((result) => {
          const startup = result.useRealCodexHome
            ? payload.realHomeStartup
            : result.substituteCodexHome
              ? buildAiVaultDropRepinStartup({
                  state: useAppStore.getState(),
                  payload,
                  substituteCodexHome: result.substituteCodexHome,
                  worktreeId
                })
              : payload
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
          const providerSession = getAiVaultAgentProviderSession({
            agent: payload.agent,
            sessionId: payload.sessionId,
            filePath: payload.sessionFilePath
          })
          const launchResult = launchAiVaultSessionInNewTab({
            agent: payload.agent,
            worktreeId,
            command: startup.command,
            ...(payload.sessionCwd ? { cwd: payload.sessionCwd } : {}),
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
                  (outcome.message
                    ? describeAiVaultResumeFailure(new Error(outcome.message), payload.agent)
                    : null) ||
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
          toast.error(describeAiVaultResumeFailure(error, payload.agent))
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
        updateTarget(event.dataTransfer, { x: event.clientX, y: event.clientY })
      }
    }

    const handleWindowDrop = (event: DragEvent): void => {
      if (!event.dataTransfer || !hasAiVaultSessionDragData(event.dataTransfer)) {
        return
      }
      if (forwardConversationReferenceDrop(event)) {
        clearDragState()
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
  }, [clearDragState, enabled, handleSessionDrop, updateTarget])

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
      // Why: the layer stands over a composer until it re-renders; a drop there is forwarded to it.
      event.dataTransfer.dropEffect =
        nextTarget || conversationReferenceDropTarget({ x: event.clientX, y: event.clientY })
          ? 'copy'
          : 'none'
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
        isDragActive && !overComposer ? 'pointer-events-auto' : 'pointer-events-none'
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
