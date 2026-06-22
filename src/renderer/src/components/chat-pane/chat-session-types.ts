import type { JcodeChatAttachment } from '../../../../shared/jcode-chat-types'
import type { JcodeToolCall } from './JcodeToolCard'

export type ChatRole = 'user' | 'assistant'

export type ChatMessage = {
  id: string
  role: ChatRole
  text: string
  /** Tool calls seen during this assistant turn, in arrival order. */
  tools?: JcodeToolCall[]
  isError?: boolean
}

export type ChatSessionState = {
  messages: ChatMessage[]
  isStreaming: boolean
  statusDetail: string | null
  /** jcode session id to pass as --resume on the next turn. */
  resumeSessionId: string | undefined
  /** Id of the assistant message currently being streamed into, if any. */
  streamingId: string | null
  /** Composer toolbar selection (Claude-style provider/model chip). Persisted
   *  per sessionKey so it survives ChatPane unmount/remount on tab switches.
   *  `undefined` provider means "Auto" (let ChatPane's default apply). */
  composerProvider: string | undefined
  composerModel: string | undefined
  /** Selected custom provider profile name (from a `jcode provider add` profile).
   *  Mutually exclusive with composerProvider: when set, the turn is sent with
   *  `providerProfile` (-> `--provider-profile`) instead of `provider` (-> -p). */
  composerProviderProfile: string | undefined
  /** Pending composer attachments (files + text blobs) for the NEXT turn.
   *  Persisted per sessionKey so they survive a tab switch before send; cleared
   *  by clearChatAttachments after the turn is dispatched. NOT persisted to disk
   *  (they are folded into the prompt the transcript already records). */
  pendingAttachments: JcodeChatAttachment[]
}

export type ChatSessionContext = { worktreeId?: string; cwd?: string }
