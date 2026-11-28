import {
  antigravityChatSignInRunning,
  type AntigravityChatSignInView
} from '../../runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'

export const isAntigravityGoogleMethod = (method: string | null | undefined): boolean =>
  method === 'oauth-personal' || method === 'oauth-business'

export type AntigravityChatSignInPrompt = 'signedOut' | 'signingIn' | 'failed'

/** The sign-in step chats still need; null once signed in or while the host hasn't said. */
export function antigravityChatSignInPrompt(
  view: AntigravityChatSignInView
): AntigravityChatSignInPrompt | null {
  if (view.status !== 'known') {
    return null
  }
  const phase = view.flow?.phase
  // A sign-in under way needs its code box whatever the host last saw.
  if (antigravityChatSignInRunning(view.flow)) {
    return 'signingIn'
  }
  if (view.auth === 'signedIn') {
    return null
  }
  if (view.auth === 'unknown') {
    return null
  }
  return view.error !== null || phase === 'failed' || phase === 'expired' ? 'failed' : 'signedOut'
}
