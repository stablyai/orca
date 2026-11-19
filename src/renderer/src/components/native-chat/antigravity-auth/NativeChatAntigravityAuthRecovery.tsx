import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { agentSessionSetupFor } from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { useNativeChatAntigravityAuth } from './native-chat-antigravity-auth'
import {
  antigravityAuthFailureReason,
  antigravityChatAuthAlternatives,
  type AntigravityAuthFailureReason
} from './antigravity-chat-auth-choices'
import {
  antigravityAlternativeLabel,
  antigravityAlternativeQuestion,
  antigravityAuthFailureLead
} from './antigravity-auth-words'

// These failures belong to a Google sign-in; once the chat uses another method they're history.
const GOOGLE_ONLY: ReadonlySet<AntigravityAuthFailureReason> = new Set([
  'noSubscription',
  'ineligible',
  'signedOut'
])
// The row already says these in its own words.
const ROW_SAYS_IT: ReadonlySet<AntigravityAuthFailureReason> = new Set(['signedOut', 'usageLimit'])

/** Under an Antigravity failure another sign-in method gets around: says why, offers the switch. */
export function NativeChatAntigravityAuthRecovery({
  agentName,
  failureKind,
  account,
  text,
  problem
}: {
  agentName: string | undefined
  failureKind: string | undefined
  account: string | undefined
  /** Everything the row shows or keeps behind Details, where a 401/403 usually is. */
  text: string
  /** The row reports a failure or warning; plain status lines never offer a switch. */
  problem: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const auth = useNativeChatAntigravityAuth()
  if (!problem || !auth?.detection || agentSessionSetupFor(agentName)?.agent !== 'antigravity') {
    return null
  }
  const reason = antigravityAuthFailureReason({ failureKind, account, text })
  const current = auth.detection.method
  const onGoogle = current === 'oauth-personal' || current === 'oauth-business'
  if (!reason || (GOOGLE_ONLY.has(reason) && !onGoogle)) {
    return null
  }
  const [option] = antigravityChatAuthAlternatives(auth.detection)
  if (!option && (ROW_SAYS_IT.has(reason) || !auth.keyAndAdc)) {
    return null
  }
  const lead = ROW_SAYS_IT.has(reason) ? null : antigravityAuthFailureLead(reason, t)
  const offer = option
    ? antigravityAlternativeQuestion(option, t)
    : t(
        'components.native-chat.antigravityAuth.otherWays',
        'You can sign in with an API key or gcloud instead.'
      )
  return (
    <div
      data-antigravity-auth-recovery=""
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-card/60 px-3 py-2 text-sm text-chat-foreground"
    >
      <p className="min-w-0 flex-1 basis-60">
        {lead ? <span className="font-medium">{lead} </span> : null}
        {offer}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {option ? (
          <Button
            type="button"
            size="xs"
            disabled={auth.switching !== null}
            onClick={() => auth.switchTo(option.method)}
          >
            {antigravityAlternativeLabel(option, t)}
          </Button>
        ) : null}
        <Button type="button" size="xs" variant="ghost" onClick={auth.openSettings}>
          {t('components.native-chat.antigravityAuth.moreOptions', 'More options…')}
        </Button>
      </div>
    </div>
  )
}
