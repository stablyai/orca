import { z } from 'zod'
export const FeishuLocalBot = z.strictObject({ botId: z.string().min(1) })
export const FeishuLocalConnect = FeishuLocalBot.extend({ profile: z.string().min(1).max(128) })
