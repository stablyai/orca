import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { AntigravityChatSignInView } from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import { useAntigravityChatAuthDetection } from '@/runtime/provider-accounts/sign-in/antigravity-chat-auth-detection'
import {
  antigravityChatSignInPrompt,
  isAntigravityGoogleMethod,
  type AntigravityChatSignInPrompt
} from '@/components/provider-accounts/antigravity-chat-runtime-sign-in-policy'
import {
  useAntigravityChatSignIn,
  useAntigravityChatSignInControls
} from '@/components/provider-accounts/use-antigravity-chat-sign-in'
import { AntigravityChatSignInFlowPanel } from '@/components/provider-accounts/AntigravityChatSignInFlowPanel'
import { useNativeChatAntigravityAuth } from '@/components/native-chat/antigravity-auth/native-chat-antigravity-auth'
import { NativeChatAntigravityAuthChooser } from '@/components/native-chat/antigravity-auth/NativeChatAntigravityAuthChooser'
import {
  antigravityAuthFailureReason,
  antigravityChatAuthAlternatives
} from '@/components/native-chat/antigravity-auth/antigravity-chat-auth-choices'
import { antigravityAuthFailureLead } from '@/components/native-chat/antigravity-auth/antigravity-auth-words'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { NativeChatInstallTile } from './NativeChatInstallTile'

export type NativeChatSignInStripState = {
  prompt: AntigravityChatSignInPrompt
  view: AntigravityChatSignInView
  agent: AgentType
  host: RuntimeClientTarget
}

/** agy's Google sign-in a chat on `host` still needs; null for other hosts, or `host` null. Only
 *  Google-method chats use agy's login, though a sign-in already running shows for every chat. */
export function useAntigravityChatSignInStrip(
  host: RuntimeClientTarget | null,
  agent: AgentType
): NativeChatSignInStripState | null {
  const view = useAntigravityChatSignIn(host)
  const method = useAntigravityChatAuthDetection(host)?.method
  const prompt = host ? antigravityChatSignInPrompt(view) : null
  if (!host || prompt === null) {
    return null
  }
  return prompt === 'signingIn' || isAntigravityGoogleMethod(method)
    ? { prompt, view, agent, host }
    : null
}

export const nativeChatSignInTitle = (agentLabel: string, t: Translate = translate): string =>
  t('components.native-chat.signIn.title', 'Sign in to {{agent}} to start chatting', {
    agent: agentLabel
  })

/** Why sign-in failed, in plain words when another method would get around it. */
function failedLine(view: AntigravityChatSignInView, t: Translate): string {
  const text = view.error || view.flow?.error || ''
  const reason = antigravityAuthFailureReason({ text })
  // The host's sentence says what to do (a code Google refused, a missing install).
  return reason === 'noSubscription' || reason === 'ineligible'
    ? antigravityAuthFailureLead(reason, t)
    : text || t('accounts.antigravity.chatFailed', 'Sign-in failed. Try again.')
}

/** The install strip's sibling once agy is installed: the detected ways to sign in first, then
 *  this client's running sign-in with Google's link and the box for its code. */
export function NativeChatSignInStrip(props: {
  state: NativeChatSignInStripState
  agentLabel: string
}): React.JSX.Element {
  const t = useTranslate()
  const auth = useNativeChatAntigravityAuth()
  const { prompt, view, agent, host } = props.state
  const signIn = useAntigravityChatSignInControls({ owner: host, disabled: false })
  const failed = prompt === 'failed'
  const signingIn = prompt === 'signingIn'
  const alternatives = antigravityChatAuthAlternatives(auth?.detection ?? null)
  return (
    <div
      data-native-chat-install="strip"
      className="flex items-start gap-3 rounded-xl border border-input bg-card px-3.5 py-3 text-sm shadow-xs"
    >
      <NativeChatInstallTile agent={agent} failed={failed} large={false} />
      <div className="min-w-0 flex-1 space-y-2.5">
        {signIn.ownFlow ? (
          <AntigravityChatSignInFlowPanel
            signIn={signIn}
            alert={null}
            title={
              <p className="font-semibold text-foreground">
                {nativeChatSignInTitle(props.agentLabel, t)}
              </p>
            }
          />
        ) : (
          <div className="flex min-h-8 items-center gap-3">
            <div className="min-w-0 flex-1">
              {signingIn ? (
                <p
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2 font-semibold text-foreground"
                >
                  <LoadingSpinner className="size-3.5" />
                  {signIn.line}
                </p>
              ) : failed ? (
                <p role="alert" className="font-semibold text-destructive">
                  {failedLine(view, t)}
                </p>
              ) : (
                <p className="font-semibold text-foreground">
                  {nativeChatSignInTitle(props.agentLabel, t)}
                </p>
              )}
            </div>
            {/* A new bot's card has no chooser, so it signs agy in directly. */}
            {!signingIn && !auth ? (
              <Button size="sm" disabled={signIn.signInDisabled} onClick={signIn.start}>
                {t('accounts.antigravity.chatSignIn', 'Sign in')}
              </Button>
            ) : null}
          </div>
        )}
        {!signingIn && auth ? (
          <NativeChatAntigravityAuthChooser auth={auth} alternatives={alternatives} />
        ) : null}
      </div>
    </div>
  )
}
