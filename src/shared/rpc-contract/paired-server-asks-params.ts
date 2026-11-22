import * as z from 'zod'
import { PeerMailSender } from './orchestration/orchestration-peer-mail-params'

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

export const PairedServerDisallowParams = z.object({ botId: ID, serverInstallationId: ID })

/** A waiting card: an agent on a paired server asked an agent here, and a person answers it. */
export const PairedServerAskCard = z.object({
  messageId: z.string(),
  environmentId: z.string(),
  botId: z.string(),
  /** The agent's name and Home chat, where a phone shows the card; absent from older hosts. */
  botName: z.string().nullish(),
  botChatSessionId: z.string().nullish(),
  /** The server's root chat the ask came from, as `orca_session_id:<id>`. */
  rootSession: z.string(),
  from: z.object({ label: z.string(), sender: PeerMailSender.nullable() }),
  subject: z.string(),
  body: z.string(),
  createdAt: z.string()
})
export type PairedServerAskCard = z.infer<typeof PairedServerAskCard>

export const PairedServerAskList = z.object({ cards: z.array(PairedServerAskCard) })
