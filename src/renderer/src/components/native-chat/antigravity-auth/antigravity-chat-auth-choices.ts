import type { AntigravityChatAuthConfig } from '../../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AntigravityChatAuthDetection } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'

type Method = AntigravityChatAuthConfig['method']

/** A sign-in method the host already has credentials for, applied in one click. */
export type AntigravityChatAuthAlternative =
  | { method: 'gemini-api-key'; source: 'saved' | 'environment' }
  | { method: 'agent-platform'; project: string }

/** Detected methods other than the one in use, best first: a key needs no Google Cloud project,
 *  gcloud needs one it can name. */
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
  return alternatives
}

export type AntigravityChatAuthMenuItem = {
  /** An older Gemini Enterprise choice is never offered; it reads as agy's Google sign-in. */
  method: Exclude<Method, 'oauth-business'>
  active: boolean
  /** The host has credentials this method would use. */
  detected: boolean
  /** Needs input only Settings collects: a key to paste, or a project and location. */
  opensSettings: boolean
}

const MENU_ORDER: readonly AntigravityChatAuthMenuItem['method'][] = [
  'oauth-personal',
  'gemini-api-key',
  'agent-platform'
]

/** Every method in a fixed order, so the menu doesn't reshuffle as detections arrive. */
export function antigravityChatAuthMenuItems(
  detection: AntigravityChatAuthDetection | null,
  keyAndAdc: boolean
): AntigravityChatAuthMenuItem[] {
  // An older Gemini Enterprise choice is agy's Google sign-in now.
  const current = detection?.method === 'oauth-business' ? 'oauth-personal' : detection?.method
  const adcReady = Boolean(detection?.adc.available && detection.adc.project)
  const detected: Record<AntigravityChatAuthMenuItem['method'], boolean> = {
    'oauth-personal': false,
    'gemini-api-key': Boolean(detection?.apiKey.available),
    'agent-platform': adcReady
  }
  return MENU_ORDER.filter((method) => keyAndAdc || method === 'oauth-personal').map((method) => ({
    method,
    active: method === current,
    detected: detected[method],
    opensSettings:
      method !== current &&
      ((method === 'gemini-api-key' && !detected[method]) ||
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
  if (SUBSCRIPTION.test(text)) {
    return 'noSubscription'
  }
  if (INELIGIBLE.test(text)) {
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

// These failures belong to the Google login; once the chat uses another method they're history. A
// missing key or gcloud login also reads as signed out, so that one stays offerable.
const GOOGLE_ONLY: ReadonlySet<AntigravityAuthFailureReason> = new Set([
  'noSubscription',
  'ineligible'
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
