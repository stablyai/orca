import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import type { NativeChatReservedAttachment } from './native-chat-session-attachment-drop'

export type UseNativeChatComposerPasteArgs = {
  targetKey?: string
  attachmentScopeKey?: string
  agent?: AgentType
  /** Re-read after awaits so a mid-paste disable guards the composer. */
  disabled: boolean
  caret: number
  /** Resolved at paste time: a remote pane must save the clipboard image on its
   *  host, or the attached path names a file the agent cannot read. */
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  attachResolvedPaths: (paths: string[], connectionId?: string | null) => void
  /** Files a file manager copied attach through the composer's drop route. */
  attachCopiedFiles: (paths: string[], options?: { focus?: boolean }) => void
  /** Captured at paste time: continues chips a paste reserved through that route once the
   *  clipboard shows they are files, even if the composer unmounted meanwhile. */
  captureCopiedFiles: (options?: {
    focus?: boolean
  }) => (reserved: NativeChatReservedAttachment[]) => Promise<void>
  /** `serverOwned`: an image the paste saved on the remote target's own server, not a client file. */
  beginPendingImageAttachment: (
    previewUrl?: string,
    pendingName?: string,
    serverOwned?: boolean
  ) => string | null
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  /** Supplies a pending chip's thumbnail. */
  revealPendingImageAttachment?: (id: string, previewUrl?: string) => void
  dropPendingImageAttachment: (id: string) => void
  insertTypedText: (text: string) => boolean
  setCaret: (caret: number) => void
  setNotice: (notice: string | null, errorText?: string) => void
}
