import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { AntigravityChatSignInView } from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import type { AntigravityChatSignInPrompt } from '@/components/provider-accounts/antigravity-chat-runtime-sign-in-policy'
import { chatSignInLine } from '@/components/provider-accounts/use-antigravity-chat-sign-in'
import { openAntigravitySignInSettings } from '@/components/provider-accounts/open-antigravity-sign-in-settings'
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

export const nativeChatSignInTitle = (agentLabel: string, t: Translate = translate): string =>
  t('components.native-chat.signIn.title', 'Sign in to {{agent}} to start chatting', {
    agent: agentLabel
  })

/** Why sign-in failed, in plain words when another method would get around it. */
function failedLine(view: AntigravityChatSignInView, t: Translate): string {
  const text = view.error || view.flow?.error || ''
  const reason = antigravityAuthFailureReason({ text })
  return reason === 'noSubscription' || reason === 'ineligible'
    ? antigravityAuthFailureLead(reason, t)
    : t('accounts.antigravity.chatFailed', 'Sign-in failed. Try again.')
}

/** The install strip's sibling once the runtime is ready: the detected ways to sign in, first. */
export function NativeChatSignInStrip(props: {
  state: NativeChatSignInStripState
  agentLabel: string
}): React.JSX.Element {
  const t = useTranslate()
  const auth = useNativeChatAntigravityAuth()
  const { prompt, view, agent, host } = props.state
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
        <div className="flex min-h-8 items-center gap-3">
          <div className="min-w-0 flex-1">
            {signingIn ? (
              <p
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 font-semibold text-foreground"
              >
                <LoadingSpinner className="size-3.5" />
                {chatSignInLine(view.flow, view.auth, view.openFailed, t)}
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
          {/* A browser that didn't open still needs Copy link and Cancel, which live in Settings. */}
          {signingIn && view.openFailed ? (
            <Button size="sm" onClick={() => openAntigravitySignInSettings(host)}>
              {t('accounts.antigravity.signInEllipsis', 'Sign in…')}
            </Button>
          ) : null}
          {!signingIn && !auth ? (
            <Button size="sm" onClick={() => openAntigravitySignInSettings(host)}>
              {t('accounts.antigravity.signInEllipsis', 'Sign in…')}
            </Button>
          ) : null}
        </div>
        {!signingIn && auth ? (
          <NativeChatAntigravityAuthChooser auth={auth} alternatives={alternatives} />
        ) : null}
      </div>
    </div>
  )
}
