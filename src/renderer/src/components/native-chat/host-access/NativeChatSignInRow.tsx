import { useNativeChatSignInCandidate } from './use-native-chat-sign-in-visibility'
import { useRef } from 'react'
import { AlertCircle, CircleCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { AgentSessionAccountKind } from '../../../../../shared/agent-session/failures/agent-session-availability'
import { sayAgentSessionFailureTranslated } from '../messages/notices/agent-session-failure-words-text'
import { NativeChatActionButton } from '../composer/controls/NativeChatActionButton'
import {
  isNativeChatFailureRowResolved,
  NativeChatHostSetupContext,
  type NativeChatHostSetup,
  useNativeChatHostSetupView
} from './native-chat-host-setup-view'
import {
  nativeChatNotSignedInSentence,
  nativeChatWasNotSignedInSentence,
  nativeChatSignInNoticeView,
  type NativeChatSignInButton as NativeChatSignInButtonView,
  type NativeChatSignInNoticeView
} from './native-chat-sign-in-notice'

const TEXT = 'min-w-0 flex-1 select-text py-px leading-5 [overflow-wrap:anywhere]'

/** One line: what's wrong and the one button that fixes it; once signed in, what to do next. */
export function NativeChatSignInRow({
  view,
  sentence,
  surface,
  action,
  className
}: {
  view: NativeChatSignInNoticeView
  sentence: string
  /** The composer's notice is a card; a transcript row is a plain line in the chat's colors. */
  surface: 'composer' | 'transcript'
  /** A second step beside Sign in, e.g. the launch's own Retry. */
  action?: { label: string; onClick: () => void; disabled?: boolean }
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const Icon = view.signedIn ? CircleCheck : AlertCircle
  const button = view.button && !view.signedIn ? view.button : null
  return (
    // The buttons wrap below the sentence as one right-aligned group, so neither is ever clipped.
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs', className)}>
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
          'min-w-32',
          surface === 'composer' ? 'text-foreground' : 'text-chat-foreground-faint'
        )}
      >
        {view.signedIn
          ? t('components.native-chat.signInNotice.signedIn', 'Signed in. Send again.')
          : (view.steps ?? sentence)}
      </p>
      {button || action ? (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {button ? <NativeChatSignInButton button={button} /> : null}
          {action ? <NativeChatActionButton {...action} /> : null}
        </div>
      ) : null}
    </div>
  )
}

export function NativeChatSignInButton({
  button
}: {
  button: NativeChatSignInButtonView
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="outline-strong"
          disabled={button.busy}
          aria-disabled={button.busy}
          aria-busy={button.busy}
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

export function NativeChatSignInAnnouncement({
  message
}: {
  message: string | undefined
}): React.JSX.Element {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {message}
    </span>
  )
}

export function NativeChatHostSetupProvider({
  value,
  children
}: {
  value: NativeChatHostSetup
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <NativeChatHostSetupContext.Provider value={value}>
      {children}
      <NativeChatSignInAnnouncement message={value.announcement} />
    </NativeChatHostSetupContext.Provider>
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
  const resolved = setup?.resolved || isNativeChatFailureRowResolved(setup, rowId)
  const eligible = !resolved && (!setup?.transcriptFailureId || setup.transcriptFailureId === rowId)
  const recovery = eligible
    ? nativeChatSignInNoticeView({ kind: 'notSignedIn', agent, account, setup }, t)
    : null
  const anchor = useRef<HTMLDivElement>(null)
  const selected = useNativeChatSignInCandidate(
    'transcript',
    rowId,
    Boolean(recovery?.button),
    anchor
  )
  const plain = setup?.signInInComposer || resolved || !eligible || !selected
  const view = plain ? null : recovery
  // A mismatched recovery must not reach the legacy setup button in the fallback.
  if (!plain && !view && !setup?.signIn) {
    return fallback(false)
  }
  return (
    <div className={cn('min-w-0 space-y-2', className)}>
      <div ref={anchor}>
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
              {resolved
                ? nativeChatWasNotSignedInSentence(agent, t)
                : sent
                  ? t(
                      'components.native-chat.signInNotice.notSent',
                      "Not sent: {{agent}} isn't signed in.",
                      { agent }
                    )
                  : nativeChatNotSignedInSentence(agent, t)}
            </p>
          </div>
        )}
      </div>
      {details}
    </div>
  )
}
