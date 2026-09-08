import { z } from 'zod'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

export const MOBILE_WEB_NATIVE_CHAT_SESSION_ID_MAX_LENGTH = 160
export const MobileWebNativeChatSessionIdSchema = z
  .string()
  .min(1)
  .max(MOBILE_WEB_NATIVE_CHAT_SESSION_ID_MAX_LENGTH)

export const MobileWebNativeChatTargetShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  sessionId: MobileWebNativeChatSessionIdSchema
} as const
