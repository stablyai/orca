import { z } from 'zod'
import { salvagedOptional, salvagingArray, salvagingRecord } from './zod-salvage'

export const explicitlySleptChatsByWorkspaceSchema = salvagingRecord(
  z.string(),
  salvagingArray(z.object({ tabId: z.string().min(1), sessionId: z.string().min(1) }))
)

export const workspaceChatSleepSessionFieldSchema = {
  explicitlySleptChatsByWorkspace: salvagedOptional(
    'explicitlySleptChatsByWorkspace',
    explicitlySleptChatsByWorkspaceSchema
  )
}
