import { z } from 'zod'

export const DeepSeekAccountOwnerParams = z.object({ ownerId: z.string().min(1).max(512) }).strict()
export const SaveDeepSeekApiKeyParams = DeepSeekAccountOwnerParams.extend({
  apiKey: z.string().trim().min(1).max(4096)
}).strict()
