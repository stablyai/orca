import { z } from 'zod'

const ID = z.string().trim().min(1).max(500)

/** A person introduced an agent on this computer in a paired server's chat (by its root chat). */
export const PairedServerAskIntroduceParams = z.object({
  environmentId: ID,
  rootSession: ID,
  botId: ID
})

export const PairedServerAskListParams = z.object({ botId: ID.optional() })

export const PairedServerAskDecideParams = z.object({
  messageId: ID,
  decision: z.enum(['once', 'always', 'deny'])
})

export const PairedServerAllowancesParams = z.object({ botId: ID })

export const PairedServerAllowParams = z.object({ botId: ID, environmentId: ID })

export const PairedServerDisallowParams = z.object({ botId: ID, serverKey: ID })
