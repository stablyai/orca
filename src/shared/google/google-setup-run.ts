// One bot's Google setup on this computer, as the host records it: which path, where each step
// stands and who did it, the account, and the owner's card answers. The bot moves it forward with
// `orca bot google-setup`; the setup cards draw from it, so they show the same on every client and
// after a restart.
import * as z from 'zod'
import { GOOGLE_ACCESS_LEVELS, GOOGLE_SERVICE_CHOICES } from './google-scopes'

/** The setup's steps, in order. */
export const GOOGLE_SETUP_STEPS = [
  // Which Google account, and whether it's work or personal.
  'account',
  'project',
  'apis',
  // The sign-in screen: app name, support email, audience, contact (holds the policy box).
  'branding',
  // A personal app's home page, privacy link and domain on Branding, so it can be published.
  'links',
  'publish',
  // The Desktop OAuth client and its key file.
  'client',
  // The owner's own sign-in with the new app, then turning Google on for the bot.
  'connect'
] as const
export type GoogleSetupStep = (typeof GOOGLE_SETUP_STEPS)[number]

/**
 * - `do-it-for-me`: the bot clicks through Google Cloud in Orca's browser.
 * - `guide-here`: Orca's browser, the person clicks, the bot only reads the page.
 * - `guide-browser`: the person's own browser, one step card at a time; the bot never clicks.
 */
export const GOOGLE_SETUP_MODES = ['do-it-for-me', 'guide-here', 'guide-browser'] as const
export type GoogleSetupMode = (typeof GOOGLE_SETUP_MODES)[number]

/** A run's path: one of the modes, or `unchosen` from an owner's start until the path card is
 *  answered. `unchosen` counts as the person clicking. */
export const GOOGLE_SETUP_RUN_MODES = [...GOOGLE_SETUP_MODES, 'unchosen'] as const
export type GoogleSetupRunMode = (typeof GOOGLE_SETUP_RUN_MODES)[number]

export const GOOGLE_SETUP_STEP_STATUSES = [
  'pending',
  'active',
  // Waiting on the person: a box only they may tick, or a step handed to them.
  'needs-user',
  'done',
  'failed',
  'skipped'
] as const
export type GoogleSetupStepStatus = (typeof GOOGLE_SETUP_STEP_STATUSES)[number]

const Text = (max: number) => z.string().min(1).max(max)

export const GoogleSetupStepStateSchema = z.object({
  status: z.enum(GOOGLE_SETUP_STEP_STATUSES),
  /** Who did it, once done: the bot or the person. */
  by: z.enum(['bot', 'user']).optional(),
  /** Epoch ms of the last change. */
  at: z.number().optional(),
  /** What the person needs to do, or what went wrong, in the bot's words. */
  note: Text(500).optional()
})
export type GoogleSetupStepState = z.infer<typeof GoogleSetupStepStateSchema>

/** An owner's answer to one card, recorded so the card locks to it on every client. */
export const GoogleSetupAnswerSchema = z.object({
  /** The choice ids, in the card's own words ("gmail", "do-it-for-me", "dana@acme.com"). */
  values: z.array(Text(320)).max(20),
  at: z.number(),
  /** Typed in chat and recorded by the bot, rather than clicked on the card. */
  typed: z.literal(true).optional()
})
export type GoogleSetupAnswer = z.infer<typeof GoogleSetupAnswerSchema>

/** Card ids answers are recorded under: `google-setup/<card>`. */
export const GOOGLE_SETUP_CARDS = ['path', 'account', 'kind', 'services', 'step'] as const
export type GoogleSetupCard = (typeof GOOGLE_SETUP_CARDS)[number]

export const GoogleSetupRunSchema = z.object({
  id: Text(80),
  botId: Text(200),
  state: z.enum(['running', 'done', 'failed', 'cancelled']),
  mode: z.enum(GOOGLE_SETUP_RUN_MODES),
  /** "Let me do this one": the person does this one step, whatever the mode. */
  personStep: z.enum(GOOGLE_SETUP_STEPS).optional(),
  steps: z.partialRecord(z.enum(GOOGLE_SETUP_STEPS), GoogleSetupStepStateSchema),
  account: Text(320).optional(),
  /** The Google accounts signed in on the setup page, as the bot read them; two or more get a pick card. */
  accounts: z.array(Text(320)).max(10).optional(),
  kind: z.enum(['work', 'personal']).optional(),
  services: z.array(z.enum(GOOGLE_SERVICE_CHOICES)).optional(),
  /** The owner's pick on the services card; absent: full. Only the owner widens it. */
  access: z.enum(GOOGLE_ACCESS_LEVELS).optional(),
  projectId: Text(120).optional(),
  /** The browser page the setup runs in; while the person clicks, the bot only reads it. */
  browserPageId: Text(200).optional(),
  answers: z.partialRecord(z.enum(GOOGLE_SETUP_CARDS), GoogleSetupAnswerSchema).default({}),
  lastError: Text(500).optional(),
  /** Orca saw the key fail to arrive (a refused download, or done refused for want of it); the
   *  owner's card then offers Make a new key and Import a key file. */
  keyMissed: z.object({ at: z.number(), reason: Text(500).optional() }).optional(),
  /** The newest copy Orca wrote of each card (by `googleSetupCardKey`), so only it acts. */
  cardCopies: z.record(z.string(), z.number().int().nonnegative()).optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  /** Raised on every change, so a card re-reads only when it moved. */
  revision: z.number().int().nonnegative()
})
export type GoogleSetupRun = z.infer<typeof GoogleSetupRunSchema>

/** The step the run is on: the first one not done or skipped; null once every step is. */
export function currentGoogleSetupStep(run: Pick<GoogleSetupRun, 'steps'>): GoogleSetupStep | null {
  return (
    GOOGLE_SETUP_STEPS.find((step) => {
      const status = run.steps[step]?.status ?? 'pending'
      return status !== 'done' && status !== 'skipped'
    }) ?? null
  )
}

/** Whether a key could still arrive: the client isn't made yet. A step left open before it (the
 *  policy box, say) mustn't stop Orca from saving a key made meanwhile. */
export function googleSetupAwaitsKey(run: Pick<GoogleSetupRun, 'state' | 'steps'>): boolean {
  const client = run.steps.client?.status
  return run.state === 'running' && client !== 'done' && client !== 'skipped'
}

/** The Google Cloud page that creates OAuth clients and shows a new one's secret in its dialog. */
export function isGoogleClientsPage(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.origin === 'https://console.cloud.google.com' &&
      parsed.pathname.startsWith('/auth/clients')
    )
  } catch {
    return false
  }
}

/** Whether the person, not the bot, does this step: the mode says so, or "Let me do this one". */
export function personDoesGoogleSetupStep(
  run: Pick<GoogleSetupRun, 'mode' | 'personStep'>,
  step: GoogleSetupStep
): boolean {
  return run.mode !== 'do-it-for-me' || run.personStep === step
}
