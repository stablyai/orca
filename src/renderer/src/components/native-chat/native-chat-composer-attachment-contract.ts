import type { RefObject } from 'react'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'
import type { NativeChatPendingAttachmentChips } from './native-chat-session-attachment-drop'
export type UseNativeChatComposerAttachmentsArgs = {
  attachmentScopeKey: string
  /** False when the agent takes no image input; see `useNativeChatResolvedPathAttachments`. */
  acceptsImages?: boolean
  /** Structured chats only: each image gets a chip in the prompt where it was attached. */
  imageReferences?: boolean
  allowWithoutTarget?: boolean
  caret: number
  disabled: boolean
  isComposing: () => boolean
  resolveTarget: () => NativeChatResolvedTarget | null
  textareaRef: RefObject<NativeChatComposerInput | null>
  setCaret: (caret: number) => void
  setDraft: (updater: (previous: string) => string) => void
  setNotice: (notice: string | null) => void
}

export type NativeChatComposerAttachments = {
  imageAttachments: NativeChatComposerImageAttachment[]
  /** A long paste in this scope is still being saved as a file; Send waits for it. */
  pastedTextSaving: boolean
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void
  clearImageAttachments: () => void
  flushPendingAttachments: () => void
  removeImageAttachment: (id: string) => void
  /** `serverOwned`: an image the paste saved on the remote target's own server, not a client file. */
  beginPendingImageAttachment: (
    previewUrl?: string,
    pendingName?: string,
    serverOwned?: boolean
  ) => string | null
  resolvePendingImageAttachment: NativeChatPendingAttachmentChips['resolve']
  revealPendingImageAttachment: (id: string, previewUrl?: string) => void
  dropPendingImageAttachment: (id: string) => boolean
  pendingChips: NativeChatPendingAttachmentChips
  /** The editor while it shows this scope; null once it went or shows another. */
  scopeEditor: () => NativeChatComposerInput | null
}
