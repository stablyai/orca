import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore, type RefObject } from 'react'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { createAddressPreviewController } from './native-chat-address-preview-controller'
import {
  CHAT_ADDRESS_PREVIEW_CLIENT_ERROR,
  type ChatAddressPreviewEntry
} from '../../../../shared/chat-address-preview'

export type NativeChatAddressPreviewsState = {
  entries: readonly ChatAddressPreviewEntry[]
  onTextPasted: (text: string) => void
  onDismiss: (id: string) => void
  onRetry: (id: string) => void
  onAllowPrivateNetwork: (id: string) => void
}

export function useNativeChatAddressPreviews({
  scopeKey,
  draft,
  inputRef,
  enabled
}: {
  scopeKey: string
  draft: string
  inputRef: RefObject<NativeChatComposerInput | null>
  enabled: boolean
}): NativeChatAddressPreviewsState {
  const controller = useMemo(
    () =>
      createAddressPreviewController(
        {
          open: async (request) => {
            const preview = window.api.fs.previewAddress
            if (!preview) {
              return {
                status: 'error',
                id: request.id,
                message: CHAT_ADDRESS_PREVIEW_CLIENT_ERROR.desktopRequired
              }
            }
            return preview(request)
          },
          release: async (id) => {
            await window.api.fs.releaseAddressPreview?.({ id })
          }
        },
        () => inputRef.current?.value ?? ''
      ),
    [inputRef]
  )
  const entries = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useLayoutEffect(() => {
    if (enabled) {
      controller.activate()
    } else {
      controller.dispose()
    }
    return () => controller.dispose()
  }, [controller, enabled, scopeKey])
  useLayoutEffect(() => {
    controller.reconcile(draft)
  }, [controller, draft])
  const retry = useCallback((id: string) => controller.retry(id), [controller])
  const allowPrivateNetwork = useCallback((id: string) => controller.retry(id, true), [controller])
  return {
    entries,
    onTextPasted: controller.pasted,
    onDismiss: controller.dismiss,
    onRetry: retry,
    onAllowPrivateNetwork: allowPrivateNetwork
  }
}
