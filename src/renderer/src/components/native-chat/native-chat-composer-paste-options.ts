import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'

export type UseNativeChatComposerPasteArgs = {
  targetKey?: string
  attachmentScopeKey?: string
  agent: AgentType
  /** Re-read after awaits so a mid-paste disable guards the composer. */
  disabled: boolean
  caret: number
  /** Resolved at paste time: SSH panes must save the clipboard image on the
   *  remote host, or the attached path names a file the agent cannot read. */
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  attachResolvedPaths: (paths: string[], connectionId?: string | null) => void
  beginPendingImageAttachment: (previewUrl?: string, pendingName?: string) => string | null
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  /** Supplies a pending chip's thumbnail. */
  revealPendingImageAttachment?: (id: string, previewUrl?: string) => void
  dropPendingImageAttachment: (id: string) => void
  insertTypedText: (text: string) => boolean
  setCaret: (caret: number) => void
  setNotice: (notice: string | null, errorText?: string) => void
}
