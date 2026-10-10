import { useLayoutEffect, useRef } from 'react'
import type { NativeChatComposerProps } from './native-chat-composer-types'
import {
  useNativeChatExternalAttachments,
  type UseNativeChatExternalAttachmentsArgs
} from './use-native-chat-external-attachments'
import { useNativeChatWorkspaceFileDrop } from './use-native-chat-workspace-file-drop'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'
import { useNativeChatPaneFileDropClaim } from './NativeChatPaneFileDropSurface'

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
    disabled: args.disabled,
    ...workspace,
    captureExternalDrop: () =>
      external.captureExternalDrop(() => destinationRef.current === destinationKey)
  })
  return {
    ...useNativeChatFileAttachmentActions(external.attachExternalPaths),
    resolveAttachmentOwner: external.resolveAttachmentOwner
  }
}
