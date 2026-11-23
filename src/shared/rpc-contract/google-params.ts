import * as z from 'zod'
import { GOOGLE_CLIENT_FILE_MAX_BYTES } from '../google/google-client-config'
import { GOOGLE_SERVICE_CHOICES } from '../google/google-scopes'
import { OptionalString, requiredString } from './rpc-param-primitives'

/** The bot run's token, so the host can refuse owner-only changes made from a bot; and its chat. */
const Caller = { botToken: OptionalString, callerSessionId: OptionalString }

const Email = z.string().trim().toLowerCase().email().max(320)

export const GoogleStatusParams = z.object({
  /** Re-read every account's services now instead of showing the last check. */
  check: z.boolean().optional()
})

export const GoogleClientImportParams = z.object({
  ...Caller,
  /** The client file's text, as downloaded from Google Cloud Console. */
  file: z.string().min(1).max(GOOGLE_CLIENT_FILE_MAX_BYTES)
})

export const GoogleClientExportParams = z.object(Caller)

export const GoogleSignInStartParams = z.object({
  ...Caller,
  /** A loopback port on the calling client: its browser returns there and it relays the address. */
  callerLoopbackPort: z.number().int().min(1024).max(65_535).optional(),
  account: Email.optional(),
  /** Gmail, Calendar, Files; absent: what the account already has, else all. Always adds to what it has. */
  services: z.array(z.enum(GOOGLE_SERVICE_CHOICES)).min(1).max(3).optional()
})

export const GoogleSignInFlowParams = z.object({ flowId: z.string().min(1).max(64) })

export const GoogleSignInWaitParams = GoogleSignInFlowParams.extend({
  afterRevision: z.number().int().nonnegative().default(0)
})

/** Paste-back and a paired desktop's hand-off alike: the address the browser ended on after Allow. */
export const GoogleFinishSignInParams = GoogleSignInFlowParams.extend({
  address: z.string().trim().min(1).max(8_192)
})

export const GoogleDisconnectParams = z.object({
  ...Caller,
  account: Email.optional(),
  revoke: z.boolean().optional()
})

export const GoogleDefaultSetParams = z.object({ ...Caller, account: Email })

export const GoogleBotAccessSetParams = z.object({
  ...Caller,
  botId: requiredString('Missing bot id'),
  on: z.boolean(),
  /** Keys (botAskerKeys) of the askers the caller showed for confirmation; Google stays off when Who can ask no longer matches. */
  confirmedAskers: z.array(z.string()).max(1000).optional()
})

/** A Connect card signed `account` in for the bot; the bot is told so, as a hidden card answer. */
export const GoogleBotConnectedParams = z.object({
  ...Caller,
  botId: requiredString('Missing bot id'),
  account: Email,
  /** The chat the card sits in, which gets the answer; the bot's Chat when absent. */
  sessionId: OptionalString
})
