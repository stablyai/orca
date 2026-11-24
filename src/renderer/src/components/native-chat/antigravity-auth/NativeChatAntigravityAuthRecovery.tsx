import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { agentSessionSetupFor } from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { agentSessionFailureDetailText } from '../../../../../shared/agent-session/failures/agent-session-failure-quoted-detail'
import { readWholeAgentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import type { NativeChatTextBlock } from '../../../../../shared/native-chat/native-chat-types'
import { nativeChatNoticeLook } from '../../../../../shared/native-chat/transcript/notices/native-chat-notice'
import { useNativeChatAntigravityAuth } from './native-chat-antigravity-auth'
import {
  antigravityAuthFailureOutlived,
  antigravityAuthFailureReason,
  antigravityChatAuthAlternatives,
  type AntigravityAuthFailureReason
} from './antigravity-chat-auth-choices'
import {
  antigravityAlternativeLabel,
  antigravityAlternativeQuestion,
  antigravityAuthFailureLead
} from './antigravity-auth-words'

// The row already says these in its own words.
const ROW_SAYS_IT: ReadonlySet<AntigravityAuthFailureReason> = new Set(['signedOut', 'usageLimit'])

/** A transcript notice's offer: Orca's own stop rows never offer one. */
export function NativeChatNoticeAuthRecovery({
  block,
  agentName
}: {
  block: NativeChatTextBlock
  agentName: string | undefined
}): React.JSX.Element | null {
  if (block.orcaStop !== undefined) {
    return null
  }
  const failure = readWholeAgentSessionFailureFact(block.failure)
  const look = nativeChatNoticeLook(block)
  return (
    <NativeChatAntigravityAuthRecovery
      agentName={agentName}
      failureKind={failure?.kind}
      problem={
        failure !== undefined ||
        (look.kind === 'line' && (look.tone === 'error' || look.tone === 'warning'))
      }
      text={[block.text, agentSessionFailureDetailText(failure), block.providerFrame?.payload?.head]
        .filter(Boolean)
        .join('\n')}
    />
  )
}

/** Under an Antigravity failure another sign-in method gets around: says why, offers the switch. */
export function NativeChatAntigravityAuthRecovery({
  agentName,
  failureKind,
  text,
  problem
}: {
  agentName: string | undefined
  failureKind: string | undefined
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
  const reason = antigravityAuthFailureReason({ failureKind, text })
  if (!reason || antigravityAuthFailureOutlived(reason, text, auth.detection.method)) {
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
