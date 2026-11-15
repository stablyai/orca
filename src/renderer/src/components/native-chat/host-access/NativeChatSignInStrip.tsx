import { LoadingSpinner } from '@/components/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { AntigravityChatSignInView } from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import type { AntigravityChatSignInPrompt } from '@/components/provider-accounts/antigravity-chat-runtime-sign-in-policy'
import { chatSignInLine } from '@/components/provider-accounts/use-antigravity-chat-sign-in'
import { openAntigravitySignInSettings } from '@/components/provider-accounts/open-antigravity-sign-in-settings'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
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

/** The install strip's sibling once the runtime is ready: sign-in happens in Settings, not here. */
export function NativeChatSignInStrip(props: {
  state: NativeChatSignInStripState
  agentLabel: string
}): React.JSX.Element {
  const t = useTranslate()
  const { prompt, view, agent, host } = props.state
  const failed = prompt === 'failed'
  return (
    <div
      data-native-chat-install="strip"
      className="flex items-center gap-3 rounded-xl border border-input bg-card px-3.5 py-3 text-sm shadow-xs"
    >
      <NativeChatInstallTile agent={agent} failed={failed} large={false} />
      <div className="min-w-0 flex-1">
        {prompt === 'signingIn' ? (
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
            {t('accounts.antigravity.chatFailed', 'Sign-in failed. Try again.')}
          </p>
        ) : (
          <p className="font-semibold text-foreground">
            {nativeChatSignInTitle(props.agentLabel, t)}
          </p>
        )}
      </div>
      {/* A browser that didn't open still needs Copy link and Cancel, which live in Settings. */}
      {prompt === 'signingIn' && !view.openFailed ? null : (
        <Button size="sm" onClick={() => openAntigravitySignInSettings(host)}>
          {t('accounts.antigravity.signInEllipsis', 'Sign in…')}
        </Button>
      )}
    </div>
  )
}
