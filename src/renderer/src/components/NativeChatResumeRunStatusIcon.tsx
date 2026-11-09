import { AlertCircle, Check, Clock, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatNativeChatDuration } from '../../../shared/native-chat/transcript/native-chat-turn-status'
import type { ResumeRunRowStatus } from './native-chat-resume-run-view'

export type ResumeRunStartPhase = 'starting' | 'ready' | null

/** In flight, the host's feed says how far the agent got; the resume itself does not report it. */
function inFlightText(phase: ResumeRunStartPhase, t: Translate = translate): string {
  return phase === 'ready'
    ? t('auto.components.NativeChatResumeRunStatusIcon.waitingForReply', 'Waiting for a reply')
    : phase === 'starting'
      ? t('auto.components.NativeChatResumeRunStatusIcon.starting', 'Starting')
      : t('auto.components.NativeChatResumeRunStatusIcon.waitingToStart', 'Waiting to start')
}

function statusText(
  status: ResumeRunRowStatus,
  phase: ResumeRunStartPhase,
  now: number,
  t: Translate = translate
): string {
  switch (status.kind) {
    case 'in-flight':
      return t(
        'auto.components.NativeChatResumeRunStatusIcon.inFlight',
        '{{value0}} · {{value1}}',
        {
          value0: inFlightText(phase, t),
          value1: formatNativeChatDuration((now - status.startedAt) / 1000)
        }
      )
    case 'resumed':
      return t('auto.components.NativeChatResumeRunStatusIcon.resumed', 'Resumed')
    case 'unconfirmed':
      return t(
        'auto.components.NativeChatResumeOutcomeRow.unconfirmed',
        'Couldn’t confirm the chat was resumed'
      )
    case 'refused':
      return t('auto.components.NativeChatResumeOutcomeRow.failed', 'Couldn’t resume')
  }
}

function StatusGlyph({ status }: { status: ResumeRunRowStatus }): React.JSX.Element {
  switch (status.kind) {
    case 'in-flight':
      return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
    case 'resumed':
      return <Check className="size-3.5 text-status-success" />
    case 'unconfirmed':
      // The same glyphs a failure row uses, so a status does not change look when its row arrives.
      return <Clock className="size-3.5 text-muted-foreground" />
    case 'refused':
      return <AlertCircle className="size-3.5 text-status-warning" />
  }
}

export function ResumeRunStatusIcon({
  status,
  phase,
  now,
  title
}: {
  status: ResumeRunRowStatus
  phase: ResumeRunStartPhase
  now: number
  /** The chat's name, so the accessible name says which chat this is. */
  title: string
}): React.JSX.Element {
  const t = useTranslate()
  const text = statusText(status, phase, now, t)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable so keyboard users reach the same tooltip. */}
        <span
          tabIndex={0}
          role="img"
          aria-label={t(
            'auto.components.NativeChatResumeOutcomeRow.statusFor',
            '{{value0}}: {{value1}}',
            { value0: title, value1: text }
          )}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <StatusGlyph status={status} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
