import type { AntigravityChatAuthConfig } from '../../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AntigravityChatAuthDetection } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import {
  ANTIGRAVITY_ACCOUNT_INELIGIBLE,
  ANTIGRAVITY_SUBSCRIPTION_REQUIRED
} from '../../../../../shared/agent-accounts/antigravity/antigravity-sign-in-sentences'

type Method = AntigravityChatAuthConfig['method']

/** A sign-in method the host already has credentials for, applied in one click. */
export type AntigravityChatAuthAlternative =
  | { method: 'gemini-api-key'; source: 'saved' | 'environment' }
  | { method: 'agent-platform'; project: string }
  | { method: 'oauth-personal' }

/** Detected methods other than the one in use, best first. A key needs no Google Cloud project,
 *  gcloud needs one it can name, and a saved Google sign-in comes last because it is what failed
 *  most often (no subscription). */
export function antigravityChatAuthAlternatives(
  detection: AntigravityChatAuthDetection | null
): AntigravityChatAuthAlternative[] {
  if (!detection) {
    return []
  }
  const current = detection.method
  const alternatives: AntigravityChatAuthAlternative[] = []
  if (current !== 'gemini-api-key' && detection.apiKey.available && detection.apiKey.source) {
    alternatives.push({ method: 'gemini-api-key', source: detection.apiKey.source })
  }
  if (current !== 'agent-platform' && detection.adc.available && detection.adc.project) {
    alternatives.push({ method: 'agent-platform', project: detection.adc.project })
  }
  const onGoogle = current === 'oauth-personal' || current === 'oauth-business'
  if (!onGoogle && detection.googleSignIn.personal) {
    alternatives.push({ method: 'oauth-personal' })
  }
  return alternatives
}

export type AntigravityChatAuthMenuItem = {
  method: Method
  active: boolean
  /** The host has credentials this method would use. */
  detected: boolean
  /** Needs input only Settings collects: a key to paste, or a project and location. */
  opensSettings: boolean
}

const MENU_ORDER: readonly Method[] = [
  'oauth-personal',
  'oauth-business',
  'gemini-api-key',
  'agent-platform'
]

/** Every method in a fixed order, so the menu doesn't reshuffle as detections arrive. */
export function antigravityChatAuthMenuItems(
  detection: AntigravityChatAuthDetection | null,
  keyAndAdc: boolean
): AntigravityChatAuthMenuItem[] {
  const current = detection?.method ?? null
  const adcReady = Boolean(detection?.adc.available && detection.adc.project)
  const detected: Record<Method, boolean> = {
    'oauth-personal': Boolean(detection?.googleSignIn.personal),
    'oauth-business': Boolean(detection?.googleSignIn.business),
    'gemini-api-key': Boolean(detection?.apiKey.available),
    'agent-platform': adcReady
  }
  return MENU_ORDER.filter(
    (method) => keyAndAdc || method === 'oauth-personal' || method === 'oauth-business'
  ).map((method) => ({
    method,
    active: method === current,
    detected: detected[method],
    opensSettings:
      method !== current &&
      (method === 'oauth-business' ||
        (method === 'gemini-api-key' && !detected[method]) ||
        (method === 'agent-platform' && !adcReady))
  }))
}

/** Why a chat or sign-in failed in a way another sign-in method could fix. */
export type AntigravityAuthFailureReason =
  | 'noSubscription'
  | 'ineligible'
  | 'signedOut'
  | 'refused'
  | 'usageLimit'

const SUBSCRIPTION = /SUBSCRIPTION_REQUIRED|eligible Antigravity subscription/i
const INELIGIBLE = /ineligible|can't use Antigravity|can’t use Antigravity/i
const USAGE_LIMIT = /usage limit reached|RESOURCE_EXHAUSTED|quota exceeded/i
// A bare status code could be a tool's request; only Google's auth words name the chat's credentials.
const REFUSED =
  /PERMISSION_DENIED|UNAUTHENTICATED|API key not valid|\b40[13]\b[^\n]{0,40}\b(?:unauthori[sz]ed|forbidden)\b/i

/** Classifies a sign-in error or a failed turn; null when switching methods wouldn't help. */
export function antigravityAuthFailureReason(input: {
  failureKind?: string
  text: string
}): AntigravityAuthFailureReason | null {
  const { text } = input
  if (text === ANTIGRAVITY_SUBSCRIPTION_REQUIRED || SUBSCRIPTION.test(text)) {
    return 'noSubscription'
  }
  if (text === ANTIGRAVITY_ACCOUNT_INELIGIBLE || INELIGIBLE.test(text)) {
    return 'ineligible'
  }
  if (input.failureKind === 'usageLimitReached' || USAGE_LIMIT.test(text)) {
    return 'usageLimit'
  }
  if (input.failureKind === 'notSignedIn') {
    return 'signedOut'
  }
  return REFUSED.test(text) ? 'refused' : null
}

// These failures belong to one method's credentials; once the chat uses another they're history.
const GOOGLE_ONLY: ReadonlySet<AntigravityAuthFailureReason> = new Set([
  'noSubscription',
  'ineligible',
  'signedOut'
])
const KEY_REJECTED = /API key not valid/i

/** The failure came from a method the chat no longer uses, so offering a switch would undo a fix. */
export function antigravityAuthFailureOutlived(
  reason: AntigravityAuthFailureReason,
  text: string,
  current: Method | null
): boolean {
  const onGoogle = current === 'oauth-personal' || current === 'oauth-business'
  return (
    (GOOGLE_ONLY.has(reason) && !onGoogle) ||
    (reason === 'refused' && KEY_REJECTED.test(text) && current !== 'gemini-api-key')
  )
}
