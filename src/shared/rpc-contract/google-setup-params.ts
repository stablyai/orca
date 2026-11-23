// `bots.googleSetup.*`: the bot moves its Google setup run; the owner's cards answer it.
import * as z from 'zod'
import {
  GOOGLE_SETUP_CARDS,
  GOOGLE_SETUP_MODES,
  GOOGLE_SETUP_STEPS
} from '../google/google-setup-run'
import { GOOGLE_SERVICE_CHOICES } from '../google/google-scopes'

const Text = (max: number) => z.string().trim().min(1).max(max)
const Values = z.array(Text(320)).min(1).max(20)

/** A bot names its run by its token and the chat it runs from; the owner names the bot. */
const Who = {
  botToken: Text(200).optional(),
  callerSessionId: Text(200).optional(),
  botId: Text(200).optional()
}

export const GoogleSetupRead = z.object(Who)

export const GoogleSetupWrite = z.object({
  ...Who,
  change: z.discriminatedUnion('action', [
    z.object({
      action: z.literal('start'),
      mode: z.enum(GOOGLE_SETUP_MODES).optional(),
      browserPageId: Text(200).optional(),
      /** Set up a new Google app even though this computer already has one. */
      newApp: z.literal(true).optional()
    }),
    z.object({
      action: z.literal('step'),
      step: z.enum(GOOGLE_SETUP_STEPS),
      status: z.enum(['pending', 'active', 'done', 'failed', 'skipped']),
      note: Text(500).optional()
    }),
    z.object({
      action: z.literal('need-user'),
      step: z.enum(GOOGLE_SETUP_STEPS),
      note: Text(500)
    }),
    z.object({
      action: z.literal('set'),
      account: Text(320).optional(),
      accounts: z.array(Text(320)).min(1).max(10).optional(),
      kind: z.enum(['work', 'personal']).optional(),
      projectId: Text(120).optional(),
      services: z.array(z.enum(GOOGLE_SERVICE_CHOICES)).optional(),
      browserPageId: Text(200).optional()
    }),
    z.object({ action: z.literal('answer'), card: z.enum(GOOGLE_SETUP_CARDS), values: Values }),
    z.object({ action: z.literal('done') }),
    z.object({ action: z.literal('fail'), error: Text(500) }),
    z.object({ action: z.literal('cancel') })
  ])
})

/** Where the owner started a setup from, for the bot's first line. */
export const GOOGLE_SETUP_STARTED_FROM = ['add-connector', 'settings'] as const

/** The owner starts (or returns to) a bot's Google setup; the bot hears it without a chat bubble. */
export const GoogleSetupStart = z.object({
  botId: Text(200),
  from: z.enum(GOOGLE_SETUP_STARTED_FROM)
})

/** An owner's click on a setup card: recorded, and told to the bot without a chat bubble. */
export const GoogleSetupAnswer = z.object({
  botId: Text(200),
  card: z.enum(GOOGLE_SETUP_CARDS),
  values: Values
})

/** The owner's Import file for an agent on another host: that host looks for the key it saved, or
 *  imports the one the owner picked from the candidates it listed. */
/** A key file on the agent's host the owner may pick; `id` names this exact file. */
export type GoogleSetupKeyCandidate = { name: string; id: string; savedAt: number }

export const GoogleSetupImportHostKey = z.object({
  botId: Text(200),
  file: z.object({ name: Text(255), id: Text(200) }).optional()
})
