import { AlertCircle, CircleCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { AgentSessionAccountKind } from '../../../../../shared/agent-session/failures/agent-session-availability'
import { sayAgentSessionFailureTranslated } from '../messages/notices/agent-session-failure-words-text'
import {
  isNativeChatFailureRowResolved,
  useNativeChatHostSetupView
} from './native-chat-host-setup'
import {
  nativeChatNotSignedInSentence,
  nativeChatSignInNoticeView,
  type NativeChatSignInButton,
  type NativeChatSignInNoticeView
} from './native-chat-sign-in-notice'

const TEXT = 'min-w-0 flex-1 select-text py-px leading-5 [overflow-wrap:anywhere]'

/** One line: what's wrong and the one button that fixes it; once signed in, what to do next. */
export function NativeChatSignInRow({
  view,
  sentence,
  surface,
  className
}: {
  view: NativeChatSignInNoticeView
  sentence: string
  /** The composer's notice is a card; a transcript row is a plain line in the chat's colors. */
  surface: 'composer' | 'transcript'
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const Icon = view.signedIn ? CircleCheck : AlertCircle
  return (
    <div className={cn('flex min-w-0 items-center gap-2 text-xs', className)}>
      <Icon
        aria-hidden
        className={cn(
          'size-3.5 shrink-0',
          view.signedIn ? 'text-status-success' : 'text-status-warning-foreground'
        )}
      />
      <p
        className={cn(
          TEXT,
          surface === 'composer' ? 'text-foreground' : 'text-chat-foreground-faint'
        )}
      >
        {view.signedIn
          ? t('components.native-chat.signInNotice.signedIn', 'Signed in. Send again.')
          : (view.steps ?? sentence)}
      </p>
      {view.button && !view.signedIn ? <SignInButton button={view.button} /> : null}
    </div>
  )
}

function SignInButton({ button }: { button: NativeChatSignInButton }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="outline-strong"
          disabled={button.busy}
          aria-description={button.description}
          onClick={button.onClick}
        >
          {button.busy ? <LoadingSpinner className="size-3" /> : null}
          {button.label}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{button.description}</TooltipContent>
    </Tooltip>
  )
}

/** A transcript row for a not-signed-in failure: plain when the composer's notice owns Sign in. */
export function NativeChatTranscriptSignInNotice({
  agentName,
  account,
  rowId,
  sent = false,
  fallback,
  details,
  className
}: {
  agentName: string | undefined
  account: AgentSessionAccountKind | undefined
  /** The transcript row that reports the failure; a later successful turn resolved it. */
  rowId?: string
  /** The row reports a message that wasn't sent; a start failure never sent one. */
  sent?: boolean
  /** Today's row, kept where this chat has no Sign in, since its sentence says how. */
  fallback: (resolved: boolean) => React.ReactNode
  /** The provider's own words, under the line. */
  details?: React.ReactNode
  className?: string
}): React.ReactNode {
  const t = useTranslate()
  const setup = useNativeChatHostSetupView()
  const agent = agentName ?? sayAgentSessionFailureTranslated('theAgent')
  // A resolved failure is history, and the composer's Sign in already fixes a current one.
  const plain = setup?.signInInComposer || isNativeChatFailureRowResolved(setup, rowId)
  const view = plain
    ? null
    : nativeChatSignInNoticeView({ kind: 'notSignedIn', agent, account, setup }, t)
  if (!plain && !view) {
    return fallback(false)
  }
  return (
    <div className={cn('min-w-0 space-y-2', className)}>
      {view ? (
        <NativeChatSignInRow
          view={view}
          sentence={nativeChatNotSignedInSentence(agent, t)}
          surface="transcript"
        />
      ) : (
        <div className="flex min-w-0 items-center gap-2 text-xs text-chat-foreground-faint">
          <AlertCircle aria-hidden className="size-3.5 shrink-0" />
          <p className={TEXT}>
            {sent
              ? t(
                  'components.native-chat.signInNotice.notSent',
                  "Not sent: {{agent}} isn't signed in.",
                  { agent }
                )
              : nativeChatNotSignedInSentence(agent, t)}
          </p>
        </div>
      )}
      {details}
    </div>
  )
}
