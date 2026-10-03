import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '../../store'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  executeTerminalPastePlan,
  planTerminalPasteWithYield,
  type TerminalPasteSource,
  type TerminalPasteTextOptions
} from './terminal-paste-coordinator'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import {
  isTerminalPanePasteFocusCurrent,
  isTerminalPanePasteTargetCurrent
} from './terminal-paste-target-state'
import { pasteTerminalText } from './terminal-bracketed-paste'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'
import { formatTerminalPasteExecutionError } from './terminal-paste-errors'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { scheduleImagePasteWebglAtlasRecovery } from './terminal-webgl-atlas-recovery'
import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import type { ReadClipboardTextOptions } from '../../../../shared/clipboard-text'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { terminalImageAttachmentScope } from './terminal-image-attachment-scope'
import { createTerminalImageAttachmentLease } from './terminal-image-attachment-lease'
import { requestTerminalImageAttachment } from './terminal-image-attachment-request'

export type TerminalPanePasteExecution = ReturnType<typeof createTerminalPanePasteExecution>

export function formatClipboardImagePasteError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Image paste failed: ${detail}`
}

export function createTerminalPanePasteExecution(
  controller: TerminalPaneCloseController,
  shortcutPlatform: NodeJS.Platform
) {
  const {
    forceBracketedMultilineTextPaste,
    managerRef,
    paneTransportsRef,
    setTerminalError,
    tabId,
    worktreeId
  } = controller
  const isPanePasteTargetMounted = (
    pane: ManagedPane,
    transport: PtyTransport | undefined,
    ptyId: string | null
  ): boolean =>
    isTerminalPanePasteTargetCurrent({
      manager: managerRef.current,
      paneTransports: paneTransportsRef.current,
      paneId: pane.id,
      leafId: pane.leafId,
      transport,
      ptyId
    })

  const executePanePasteText = async (
    pane: ManagedPane,
    source: TerminalPasteSource,
    activeElementAtDispatch: Element | null,
    text: string,
    options?: TerminalPasteTextOptions,
    admission?: () => boolean,
    onDeliveryStarted?: () => Promise<void>
  ): Promise<boolean> => {
    const connectionId = getConnectionId(worktreeId) ?? null
    const transport = paneTransportsRef.current.get(pane.id)
    const ptyId = transport?.getPtyId() ?? null
    const keyboardOwnedPaste =
      source === 'keyboard' || source === 'paste-event' || source === 'app-menu'
    const plan = await planTerminalPasteWithYield({
      text,
      source,
      target: {
        kind: 'terminal',
        paneId: pane.id,
        leafId: pane.leafId,
        ptyId,
        runtime: resolveTerminalPasteRuntime({
          platform: shortcutPlatform,
          ptyId,
          connectionId,
          remotePlatform: getTerminalPasteSshRemotePlatform(connectionId),
          transport,
          isWindowsConpty: forceBracketedMultilineTextPaste
        })
      },
      forceBracketedPaste: options?.forceBracketedPaste,
      forceBracketedPasteForMultiline: options?.forceBracketedPasteForMultiline,
      terminalBracketedPasteMode: pane.terminal.modes.bracketedPasteMode
    })
    const execution = await executeTerminalPastePlan(plan, {
      pasteText: (pasteText, pasteOptions) => {
        if (!onDeliveryStarted) {
          return pasteTerminalText(pane.terminal, pasteText, pasteOptions)
        }
        return onDeliveryStarted().then(() => {
          if (admission?.() === false) {
            throw new Error('Image preview was canceled')
          }
          return pasteTerminalText(pane.terminal, pasteText, pasteOptions)
        })
      },
      writePty: (data) => {
        if (!onDeliveryStarted) {
          return writeTerminalPastePtyInput(transport, data, 'driving')
        }
        return onDeliveryStarted().then(() =>
          admission?.() === false ? false : writeTerminalPastePtyInput(transport, data, 'driving')
        )
      },
      isTargetCurrent: () => {
        if (admission?.() === false || !isPanePasteTargetMounted(pane, transport, ptyId)) {
          return false
        }
        return isTerminalPanePasteFocusCurrent({
          requireSameFocusedElement: keyboardOwnedPaste,
          activeElementAtDispatch,
          paneContainer: pane.container
        })
      },
      canContinue: () => admission?.() !== false && isPanePasteTargetMounted(pane, transport, ptyId)
    })
    if (execution.status !== 'pasted') {
      setTerminalError(formatTerminalPasteExecutionError(execution.reason))
      return false
    }
    if (text) {
      recordTerminalUserInputForLeaf(tabId, pane.leafId)
    }
    if (options?.recoverImagePasteWebglAtlas) {
      scheduleImagePasteWebglAtlasRecovery()
    }
    return true
  }

  const pasteFromClipboard = (
    pane: ManagedPane,
    source: Extract<TerminalPasteSource, 'keyboard' | 'paste-event' | 'app-menu'>,
    readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string> = window.api.ui
      .readClipboardText
  ): void => {
    const connectionId = getConnectionId(worktreeId) ?? null
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
      useAppStore.getState(),
      worktreeId
    )
    const activeElementAtDispatch = document.activeElement
    const paneKey = makePaneKey(tabId, pane.leafId)
    const transport = paneTransportsRef.current.get(pane.id)
    const ptyId = transport?.getPtyId() ?? null
    const scope = terminalImageAttachmentScope(useAppStore.getState(), paneKey, ptyId)
    const isCurrent = () =>
      isPanePasteTargetMounted(pane, transport, ptyId) &&
      managerRef.current?.getActivePane()?.id === pane.id &&
      terminalImageAttachmentScope(useAppStore.getState(), paneKey, ptyId) === scope
    let fullSizePreviewUrl: string | undefined
    let savedRuntimeEnvironmentId = runtimeEnvironmentId
    const settlePreview = (path: string, action: 'discard' | 'retain' | 'release') =>
      window.api.ui.settleClipboardImagePreview({
        path,
        connectionId,
        runtimeEnvironmentId: savedRuntimeEnvironmentId,
        retain: action !== 'discard',
        release: action === 'release'
      })
    const onCleanupError = (error: unknown) =>
      setTerminalError(
        `Image preview cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      )
    void pasteTerminalClipboard({
      readClipboardText,
      saveClipboardImageAsTempFile: scope
        ? async (args) => {
            const preview = await window.api.ui.saveClipboardImagePreview(args)
            fullSizePreviewUrl = preview?.dataUrl
            savedRuntimeEnvironmentId = preview?.runtimeEnvironmentId ?? runtimeEnvironmentId
            return preview?.path ?? null
          }
        : window.api.ui.saveClipboardImageAsTempFile,
      connectionId,
      runtimeEnvironmentId,
      forceBracketedMultilineTextPaste,
      stageImage: scope
        ? (path) => {
            if (
              !isCurrent() ||
              !isTerminalPanePasteFocusCurrent({
                requireSameFocusedElement: true,
                activeElementAtDispatch,
                paneContainer: pane.container
              })
            ) {
              void settlePreview(path, 'discard').catch(onCleanupError)
              return false
            }
            const lease = createTerminalImageAttachmentLease({
              isCurrent,
              settle: (action) => settlePreview(path, action),
              onError: onCleanupError
            })
            const admitted = lease.isCurrent
            const staged = requestTerminalImageAttachment(pane.container, {
              attachment: {
                id: createBrowserUuid(),
                path,
                connectionId: connectionId ?? undefined
              },
              fullSizePreviewUrl,
              isCurrent: admitted,
              cancel: lease.cancel,
              attach: async () =>
                admitted() && (await lease.prepareDelivery())
                  ? executePanePasteText(
                      pane,
                      'programmatic',
                      null,
                      path,
                      {
                        forceBracketedPaste: true,
                        recoverImagePasteWebglAtlas: true
                      },
                      admitted,
                      lease.deliveryStarted
                    )
                  : Promise.resolve(false)
            })
            if (!staged) {
              lease.cancel()
              setTerminalError(
                'Image preview unavailable or full (maximum 4). Return to the Codex pane and paste again.'
              )
            }
            return staged
          }
        : undefined,
      pasteText: (text, options) =>
        executePanePasteText(pane, source, activeElementAtDispatch, text, options),
      onTextPasteError: () =>
        setTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.'),
      onImagePasteError: (error) => setTerminalError(formatClipboardImagePasteError(error))
    }).catch(() => {
      setTerminalError('Paste failed.')
    })
  }

  return { executePanePasteText, pasteFromClipboard }
}
