import { z } from 'zod'
import { matchesMobileWebProtocolToken } from './protocol-token-contract'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

export const MobileWebNativeChatSessionIdSchema = z
  .string()
  .refine((value) => matchesMobileWebProtocolToken(value, /^native_chat_[a-z0-9]+_[a-f0-9]{32}$/))

export const MobileWebNativeChatTargetShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  sessionId: MobileWebNativeChatSessionIdSchema
} as const
