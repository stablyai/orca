import { useCallback, useState } from 'react'
import { AlertTriangle, Loader2, LogIn, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

export type NativeChatAgentAccountReauthResult = { ok: true } | { ok: false; message: string }

export type NativeChatAgentNoticeBannerProps = {
  message: NativeChatMessage
  text: string
  /** Present only when the notice is `noticeKind: 'login-required'` for an
   *  agent this view knows how to reauthenticate (Claude, for now). Absent
   *  notices/agents fall back to the plain descriptive banner with no CTA. */
  onReauthenticateAccount?: () => Promise<NativeChatAgentAccountReauthResult>
  onSwitchToTerminal?: () => void
}

type ReauthState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'done'; result: NativeChatAgentAccountReauthResult }

/** Inline banner for a provider notice the user must actually see — as opposed
 *  to the quiet, chrome-free system asides other transcript markers render as
 *  (see `MessageRow`'s plain `isSystem` branch). A `login-required` notice adds
 *  a "reauthenticate" action; everything else is a plain descriptive banner,
 *  which alone already beats today's silence. */
export function NativeChatAgentNoticeBanner({
  message,
  text,
  onReauthenticateAccount,
  onSwitchToTerminal
}: NativeChatAgentNoticeBannerProps): React.JSX.Element {
  const isLoginRequired = message.noticeKind === 'login-required'
  const [reauth, setReauth] = useState<ReauthState>({ kind: 'idle' })

  const handleReauthenticate = useCallback(() => {
    if (!onReauthenticateAccount || reauth.kind === 'pending') {
      return
    }
    setReauth({ kind: 'pending' })
    onReauthenticateAccount().then(
      (result) => setReauth({ kind: 'done', result }),
      (error: unknown) =>
        setReauth({
          kind: 'done',
          result: { ok: false, message: error instanceof Error ? error.message : String(error) }
        })
    )
  }, [onReauthenticateAccount, reauth.kind])

  return (
    <div
      role={isLoginRequired ? 'alert' : 'status'}
      className={cn(
        'flex w-full flex-col gap-2 rounded-lg border px-4 py-3 text-sm',
        isLoginRequired
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200'
          : 'border-border bg-card text-muted-foreground'
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <p className="min-w-0 break-words">{text}</p>
      </div>
      {isLoginRequired ? (
        <div className="flex flex-wrap items-center gap-2">
          {onReauthenticateAccount ? (
            <button
              type="button"
              onClick={handleReauthenticate}
              disabled={reauth.kind === 'pending'}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
            >
              {reauth.kind === 'pending' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <LogIn className="size-3.5" />
              )}
              {translate('components.native-chat.notice.reauthenticate', 'Reauthenticate account')}
            </button>
          ) : null}
          {onSwitchToTerminal ? (
            <button
              type="button"
              onClick={onSwitchToTerminal}
              className="flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <TerminalSquare className="size-3.5" />
              {translate('components.native-chat.notice.goToTerminal', 'Go to Terminal')}
            </button>
          ) : null}
        </div>
      ) : null}
      {reauth.kind === 'done' ? (
        <p className={cn('text-xs', reauth.result.ok ? 'text-foreground' : 'text-destructive')}>
          {reauth.result.ok
            ? translate(
                'components.native-chat.notice.reauthenticateSuccess',
                'Account reauthenticated. If the agent in this pane still isn’t responding, click "Go to Terminal" and restart the session there.'
              )
            : reauth.result.message}
        </p>
      ) : null}
    </div>
  )
}
