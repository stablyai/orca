import { useCallback, useEffect } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { CLIPBOARD_TEXT_READ_MAX_BYTES } from '../../../../../shared/clipboard-text'
import type {
  RemoteBrowserPaneNotice,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'

export function useRemoteBrowserPageClipboardPaste({
  busy,
  imageRef,
  runtimeTarget,
  lifecycle,
  runtimeWorktree,
  enqueueRemoteInput,
  createRemoteOperationToken,
  isCurrentRemoteOperationToken,
  setPaneNotice
}: {
  busy: boolean
  imageRef: React.RefObject<HTMLImageElement | null>
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  setPaneNotice: React.Dispatch<React.SetStateAction<RemoteBrowserPaneNotice | null>>
}): (activeElementAtDispatch: Element | null) => boolean {
  const remotePageId = lifecycle.tokens.remotePage
  const pasteRemoteClipboard = useCallback(
    (activeElementAtDispatch: Element | null): boolean => {
      if (
        busy ||
        activeElementAtDispatch === null ||
        activeElementAtDispatch !== imageRef.current ||
        document.activeElement !== activeElementAtDispatch
      ) {
        return false
      }

      const target = runtimeTarget()
      const operationToken = remotePageId ? createRemoteOperationToken(remotePageId) : null
      if (!target || !remotePageId || !operationToken) {
        return false
      }

      setPaneNotice(null)
      void enqueueRemoteInput(async () => {
        if (!isCurrentRemoteOperationToken(operationToken)) {
          return
        }
        try {
          const text = await window.api.ui.readClipboardText({
            maxBytes: CLIPBOARD_TEXT_READ_MAX_BYTES
          })
          if (!text || !isCurrentRemoteOperationToken(operationToken)) {
            return
          }
          await callRuntimeRpc(
            target,
            'browser.keyboardInsertText',
            { worktree: runtimeWorktree, page: remotePageId, text },
            { timeoutMs: 15_000, suppressFeatureInteraction: true }
          )
        } catch (error) {
          if (isCurrentRemoteOperationToken(operationToken)) {
            setPaneNotice({
              kind: 'consequence',
              text: error instanceof Error ? error.message : 'Remote paste failed.'
            })
          }
        }
      })
      return true
    },
    [
      busy,
      createRemoteOperationToken,
      enqueueRemoteInput,
      imageRef,
      isCurrentRemoteOperationToken,
      remotePageId,
      runtimeTarget,
      runtimeWorktree,
      setPaneNotice
    ]
  )

  useEffect(() => {
    const handlePaste = (event: Event): void => {
      if (!pasteRemoteClipboard(imageRef.current)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener(APP_MENU_PASTE_EVENT, handlePaste)
    return () => window.removeEventListener(APP_MENU_PASTE_EVENT, handlePaste)
  }, [imageRef, pasteRemoteClipboard])

  return pasteRemoteClipboard
}
