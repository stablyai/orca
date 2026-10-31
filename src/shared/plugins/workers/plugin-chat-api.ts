import { z } from 'zod'

const sessionId = z.string().min(1).max(512)
export const pluginChatCursor = z.strictObject({
  epoch: z.string().min(1).max(512),
  sequence: z.number().int().nonnegative()
})
export const pluginChatTarget = z.strictObject({ sessionId })
export const pluginChatList = z.array(z.strictObject({ sessionId, agent: z.string() })).max(100)
export const pluginChatContext = z.strictObject({
  cursor: pluginChatCursor,
  fence: z.number().int().positive(),
  transcript: z.string().max(65536),
  latestUserMessage: z.string().max(262144),
  truncated: z.boolean()
})
export const pluginChatHandoff = z.strictObject({
  sessionId,
  operationId: z.string().min(1).max(512),
  fence: z.number().int().positive(),
  cursor: pluginChatCursor,
  context: z.string().min(1).max(65536)
})
export const pluginChatHandoffResult = z.strictObject({
  completed: z.boolean(),
  reason: z.string().optional(),
  retry: z.boolean().optional()
})
export type PluginChatContext = z.infer<typeof pluginChatContext>
export type PluginChatHandoff = z.infer<typeof pluginChatHandoff>
export type PluginChatServices = {
  list(workspaceId: string): Promise<z.infer<typeof pluginChatList>>
  read(workspaceId: string, sessionId: string): Promise<PluginChatContext>
  handoff(
    workspaceId: string,
    pluginId: string,
    params: PluginChatHandoff
  ): Promise<z.infer<typeof pluginChatHandoffResult>>
}
