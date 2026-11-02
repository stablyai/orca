import { useCallback, useLayoutEffect, useRef } from 'react'
import type { NativeChatComposerProps } from './native-chat-composer-types'
import {
  useNativeChatExternalAttachments,
  type UseNativeChatExternalAttachmentsArgs
} from './use-native-chat-external-attachments'
import { useNativeChatWorkspaceFileDrop } from './use-native-chat-workspace-file-drop'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'
import { useNativeChatPaneFileDropClaim } from './NativeChatPaneFileDropSurface'
import type { NativeChatAttachmentFocusOptions } from './native-chat-resolved-path-ownership'

type Args = UseNativeChatExternalAttachmentsArgs &
  Pick<NativeChatComposerProps, 'paneKey' | 'draftScopeKey' | 'targetPtyId' | 'structuredTransport'>

export function useNativeChatFileDrops(args: Args) {
  const external = useNativeChatExternalAttachments(args)
  const workspace = useNativeChatWorkspaceFileDrop(args)
  const destinationKey = JSON.stringify([
    args.paneKey,
    args.draftScopeKey,
    args.targetPtyId,
    args.structuredTransport?.sessionId,
    args.structuredTransport?.worktreeId,
    args.structuredTransport?.runtimeEnvironmentId
  ])
  const destinationRef = useRef(destinationKey)
  useLayoutEffect(() => {
    destinationRef.current = destinationKey
  }, [destinationKey])
  useNativeChatPaneFileDropClaim({
    destinationKey,
    focusScopeKey: args.draftScopeKey ?? args.paneKey,
    disabled: args.disabled,
    ...workspace,
    captureExternalDrop: () =>
      external.captureExternalDrop(() => destinationRef.current === destinationKey)
  })
  const { captureReservedAttachments } = external
  // A paste's files keep this destination, which a later retarget or deletion cancels.
  const captureCopiedFiles = useCallback(
    (options?: NativeChatAttachmentFocusOptions) =>
      captureReservedAttachments(() => destinationRef.current === destinationKey, options),
    [captureReservedAttachments, destinationKey]
  )
  return {
    ...useNativeChatFileAttachmentActions(external.captureExternalDrop),
    attachExternalPaths: external.attachExternalPaths,
    captureExternalPaths: external.captureExternalDrop,
    captureCopiedFiles,
    resolveAttachmentOwner: external.resolveAttachmentOwner
  }
}
