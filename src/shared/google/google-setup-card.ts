// A Google setup card in a bot's chat. Orca writes it when the bot asks for one; the card itself
// draws from the bot's setup run, so it locks and updates on every client. Older clients paint its
// `text` as a plain line.
import * as z from 'zod'
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../agent-session/journal/agent-session-journal-types'
import { GOOGLE_SETUP_STEPS } from './google-setup-run'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

export const GOOGLE_SETUP_CARD_PRESENTATION = 'google-setup'

/**
 * - `path`, `account`, `services`: a choice the owner answers once.
 * - `progress`: the live step list.
 * - `step`: one step the person does, with Open, Done and Take over.
 * - `connect`: the owner's own sign-in with the new app.
 * - `connected`: what the bot can now use.
 */
export const GOOGLE_SETUP_CARD_KINDS = [
  'path',
  'account',
  'services',
  'progress',
  'step',
  'connect',
  'connected'
] as const
export type GoogleSetupCardKind = (typeof GOOGLE_SETUP_CARD_KINDS)[number]

export const GoogleSetupCardRefSchema = lazyZodSchema(() =>
  z.object({
    botId: z.string().min(1).max(200),
    /** The run it belongs to; a card from an earlier run says it ended rather than showing this one. */
    runId: z.string().min(1).max(80),
    card: z.enum(GOOGLE_SETUP_CARD_KINDS),
    /** The step a `step` card is about. */
    step: z.enum(GOOGLE_SETUP_STEPS).optional(),
    /** Which copy this is, when Orca writes the card more than once; the run names the newest. */
    copy: z.number().int().nonnegative().optional()
  })
)
export type GoogleSetupCardRef = z.infer<typeof GoogleSetupCardRefSchema>

/** One card in the run, whichever copy: `connect`, or `step:branding`. */
export function googleSetupCardKey(ref: Pick<GoogleSetupCardRef, 'card' | 'step'>): string {
  return ref.step ? `step:${ref.step}` : ref.card
}

/** Whether this copy acts: the newest the run wrote, by transcript order rather than what's shown. */
export function isNewestGoogleSetupCard(
  run: { cardCopies?: Record<string, number> },
  ref: GoogleSetupCardRef
): boolean {
  return (run.cardCopies?.[googleSetupCardKey(ref)] ?? 0) === (ref.copy ?? 0)
}

const FALLBACK: Record<GoogleSetupCardKind, string> = {
  path: 'Google setup: choose how to set it up in Orca on your computer.',
  account: 'Google setup: choose the Google account in Orca on your computer.',
  services: 'Google setup: choose the Google services in Orca on your computer.',
  progress: 'Google setup is in progress. Follow it in Orca on your computer.',
  step: 'Google setup needs you. Continue in Orca on your computer.',
  connect: 'Google setup: sign in to connect in Orca on your computer.',
  connected: 'Google is connected.'
}

export function googleSetupCardBody(
  ref: GoogleSetupCardRef
): AgentJournalPlainStatusItem & { googleSetup: GoogleSetupCardRef } {
  return {
    kind: 'status',
    text: FALLBACK[ref.card],
    presentation: GOOGLE_SETUP_CARD_PRESENTATION,
    googleSetup: ref
  }
}

/** The card on a journal item, or null when it carries none or one this build can't read. */
export function googleSetupCardOf(body: AgentJournalItemBody): GoogleSetupCardRef | null {
  if (!('googleSetup' in body)) {
    return null
  }
  const parsed = GoogleSetupCardRefSchema.safeParse(body.googleSetup)
  return parsed.success ? parsed.data : null
}
