// Why a one-trip setup stopped, as the setup session reports it (`error.kind`), and the one
// action each offers. Copy lives in CloudSetupErrorNotice; this file stays pure for tests.
import { z } from 'zod'
import { CLOUD_SETUP_ERROR_KIND_VALUES } from '../../../../../shared/telemetry-cloud-setup-event-schemas'

export type CloudSetupErrorKind = Exclude<(typeof CLOUD_SETUP_ERROR_KIND_VALUES)[number], 'other'>

export type CloudSetupError = {
  kind: CloudSetupErrorKind
  /** wrong_account: the signed-in email; anything else ignores it. */
  detail?: string
  /** wrong_account: the team the setup was for. */
  teamName?: string
}

/** What the error's single button does; the composer (or the fixture) wires each one. */
export type CloudSetupErrorAction =
  | 'reopen-browser'
  | 'try-again'
  | 'choose-plan'
  | 'switch-account'

const ACTIONS: Record<CloudSetupErrorKind, CloudSetupErrorAction> = {
  // Nothing happened for 15 minutes, or sign-in was canceled: the same tab can pick up again.
  timed_out: 'reopen-browser',
  checkout_canceled: 'try-again',
  // 3-D Secure / bank confirmation is waiting on Stripe's page.
  bank_step: 'reopen-browser',
  trial_unavailable: 'choose-plan',
  team_create_failed: 'try-again',
  wrong_account: 'switch-account'
}

export function cloudSetupErrorAction(kind: CloudSetupErrorKind): CloudSetupErrorAction {
  return ACTIONS[kind]
}

/** Neutral kinds describe a choice or a pause, not a failure; only real failures read as errors. */
export function cloudSetupErrorTone(kind: CloudSetupErrorKind): 'error' | 'neutral' {
  return kind === 'team_create_failed' ? 'error' : 'neutral'
}

const KNOWN_KINDS = CLOUD_SETUP_ERROR_KIND_VALUES.filter(
  (kind): kind is CloudSetupErrorKind => kind !== 'other'
)
const RawErrorSchema = z.object({ kind: z.string(), detail: z.unknown().optional() })

/** Parses the session's untrusted `error` field; unknown kinds are dropped (shown as no error). */
export function parseCloudSetupError(raw: unknown): CloudSetupError | null {
  const parsed = RawErrorSchema.safeParse(raw)
  if (!parsed.success) {
    return null
  }
  const kind = KNOWN_KINDS.find((known) => known === parsed.data.kind)
  if (!kind) {
    return null
  }
  const { detail } = parsed.data
  return {
    kind,
    ...(typeof detail === 'string' && detail.length > 0 && detail.length <= 320 ? { detail } : {})
  }
}
