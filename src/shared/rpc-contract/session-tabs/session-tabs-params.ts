import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/** `agent-sessions`: the stream's reader applies chat tabs only, so terminal hook status is not sent. */
export const SessionTabsSubscribeAllParams = lazyZodSchema(() =>
  z.object({ scope: z.literal('agent-sessions').optional() }).nullish()
)

export const SessionTabsUnsubscribeAllParams = lazyZodSchema(() =>
  z
    .object({
      subscriptionId: z.string().min(1).optional()
    })
    .nullish()
)
