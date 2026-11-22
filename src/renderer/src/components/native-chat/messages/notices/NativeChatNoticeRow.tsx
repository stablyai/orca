import { AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { nativeChatNoticeLookRow, toneClass } from './NativeChatNoticeLookRows'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatNoticeLook } from '../../../../../../shared/native-chat/transcript/notices/native-chat-notice'
import { NativeChatGoalCheckNotice } from './NativeChatGoalCheckNotice'
import { NativeChatUsageLimitRow } from '../../usage/NativeChatUsageLimitRow'
import { agentSessionGoalControlWords } from '../../session/goals/agent-session-goal-control-words'
import { useTranslation } from 'react-i18next'
import { NativeChatPullRequestEventLine } from './NativeChatPullRequestEventLine'
import { PULL_REQUEST_EVENT_PRESENTATION } from '../../../../../../shared/native-chat/transcript/notices/native-chat-pull-request-event'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useNativeChatOrcaStopView } from './native-chat-orca-stop-context'
import { NativeChatInterruptedContinueButton } from '../../usage/NativeChatInterruptedContinue'
import { nativeChatOrcaStopRowText } from '../../../../../../shared/native-chat/transcript/continuation/native-chat-orca-stop-words'
import { sayNativeChatOrcaStopTranslated } from './native-chat-orca-stop-words-text'
import * as Details from '../diagnostics/NativeChatProviderDetails'
import { agentSessionRestartNoteText } from './agent-session-restart-note-text'
import { NativeChatSetupButton } from '../../host-access/NativeChatSetupButton'
import {
  isNativeChatFailureRowResolved,
  isNativeChatSetupFailureKind,
  useNativeChatHostSetupView
} from '../../host-access/native-chat-host-setup'
import { agentSessionFailureDetailText } from '../../../../../../shared/agent-session/failures/agent-session-failure-quoted-detail'
import { readWholeAgentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../../../shared/agent-session/failures/agent-session-failure-words'
import {
  agentCliInstallationFailureWords,
  sayAgentSessionFailureEnglish
} from '../../../../../../shared/agent-session/failures/agent-session-failure-copy'
import { structuredAgentSessionHostPlace } from '../../pane/ownership/use-structured-agent-session-host-label'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { NativeChatTranscriptSignInNotice } from '../../host-access/NativeChatSignInRow'
import { nativeChatSignInHostWords } from '../../host-access/native-chat-sign-in-notice'
import { NativeChatNoticeAuthRecovery } from '../../antigravity-auth/NativeChatAntigravityAuthRecovery'
import { NATIVE_CHAT_GOAL_CHECK_SUMMARY } from '../../../../../../shared/native-chat/transcript/turns/native-chat-thread-goal-rows'

export function NativeChatNoticeRow({
  block,
  messageId,
  timestamp = null,
  agentName
}: {
  block: NativeChatTextBlock
  /** The transcript row's message, so a plan's code blocks keep their wrap past the row's mount. */
  messageId?: string
  timestamp?: number | null
  agentName?: string
}): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const orcaStopView = useNativeChatOrcaStopView()

  if (block.presentation === NATIVE_CHAT_GOAL_CHECK_SUMMARY) {
    return <NativeChatGoalCheckNotice text={block.text} />
  }

  if (block.presentation === PULL_REQUEST_EVENT_PRESENTATION) {
    return (
      <NativeChatPullRequestEventLine block={block} messageId={messageId} timestamp={timestamp} />
    )
  }
  const look = nativeChatNoticeLook(block)
  const looked = nativeChatNoticeLookRow({ block, messageId, timestamp, agentName, t })
  if (looked) {
    return looked
  }
  // Name Orca and its host as the stop cause; without host context, preserve the original words.
  const { orcaStop } = block
  const { hostLabel, remoteHost, continueAvailable, wslDistro } = orcaStopView
  // A paired server with no name to show is still a remote server; its id is not a name.
  const machine =
    hostLabel ?? (remoteHost ? sayNativeChatOrcaStopTranslated('unnamedServer') : null)
  const named = orcaStop !== undefined && machine !== null
  const continueOffered =
    orcaStop?.turnItemId !== undefined && orcaStop.turnItemId === orcaStopView.offeredTurnItemId
  const failure = readWholeAgentSessionFailureFact(block.failure)
  // Reword only text fully described by its fact; other host text may carry command advice.
  const factSurface =
    failure &&
    [
      'notSignedIn',
      'savedConversationMissing',
      'pluginInputRequired',
      'modelUnavailable',
      'providerUnavailable',
      'providerSafetyStopped',
      'providerResponseFailed'
    ].includes(failure.kind)
      ? (['row', 'rejection'] as const).find(
          (surface) => block.text === agentSessionFailureSentence(failure, surface, { agentName })
        )
      : undefined
  // The host can't tell it's a WSL host; name the distro only over its plain not-installed words.
  const wslMissingSurface =
    failure?.kind === 'cliMissing' && wslDistro
      ? (['row', 'rejection'] as const).find(
          (surface) => block.text === agentSessionFailureSentence(failure, surface, { agentName })
        )
      : undefined
  // The host calls itself this computer; a too-old CLI's words name the host as this reader does.
  const cliTooOldSurface =
    failure?.kind === 'startFailed' &&
    agentCliInstallationFailureWords(failure.refusal, sayAgentSessionFailureEnglish)
      ? (['row', 'rejection'] as const).find(
          (surface) => block.text === agentSessionFailureSentence(failure, surface, { agentName })
        )
      : undefined
  const text = named
    ? nativeChatOrcaStopRowText(
        orcaStop.cause,
        machine,
        { continueAvailable, remoteHost },
        sayNativeChatOrcaStopTranslated
      )
    : failure && factSurface
      ? agentSessionFailureSentence(
          failure,
          factSurface,
          { agentName },
          sayAgentSessionFailureTranslated
        )
      : failure && wslMissingSurface && wslDistro
        ? agentSessionFailureSentence(
            failure,
            wslMissingSurface,
            { agentName, wslDistro },
            sayAgentSessionFailureTranslated
          )
        : failure && cliTooOldSurface
          ? agentSessionFailureSentence(
              failure,
              cliTooOldSurface,
              { agentName, hostName: structuredAgentSessionHostPlace(remoteHost, hostLabel, t) },
              sayAgentSessionFailureTranslated
            )
          : (agentSessionRestartNoteText(block.text, t) ?? agentSessionGoalControlWords(block.text))
  const failureDetail = agentSessionFailureDetailText(failure)
  if (block.orcaStop === undefined && failure?.kind === 'usageLimitReached') {
    return (
      <NativeChatUsageLimitRow
        block={block}
        failure={failure}
        agentName={agentName}
        detail={failureDetail?.trim() ? failureDetail : undefined}
        active={
          block.usageLimitTurnItemId !== undefined &&
          block.usageLimitTurnItemId === orcaStopView.usageLimitTurnItemId
        }
      />
    )
  }
  const detail = failureDetail?.trim() !== text.trim() ? failureDetail : undefined
  const tone = named ? 'notice' : look.kind === 'line' ? look.tone : null
  const Icon =
    tone === 'warning'
      ? AlertTriangle
      : tone === 'error'
        ? AlertCircle
        : tone === 'notice'
          ? Info
          : null
  const details =
    block.providerFrame || detail ? (
      <Details.ProviderFrameRow
        block={block}
        detail={detail}
        summary={t('components.native-chat.notices.details', 'Details')}
      />
    ) : null
  const row = (resolved: boolean): React.JSX.Element => (
    <div
      className={cn(
        'space-y-2 text-sm text-chat-foreground',
        Icon && !resolved && 'rounded-md border border-border bg-muted/20 p-3',
        tone && toneClass(resolved ? 'notice' : tone)
      )}
    >
      <div className="flex items-start gap-2">
        {Icon ? <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> : null}
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{text}</p>
        {continueOffered ? (
          <NativeChatInterruptedContinueButton onContinue={orcaStopView.continueNow} />
        ) : null}
      </div>
      <NativeChatSetupButton failureKind={block.failure?.kind} rowId={messageId} />
      {resolved ? null : <NativeChatNoticeAuthRecovery block={block} agentName={agentName} />}
      {details}
    </div>
  )
  if (!named && failure?.kind === 'notSignedIn') {
    // The fact names the failure, so an older host's longer sentence still reads as the short one;
    // words beyond the standard sentence stay under Details.
    const hostWords = nativeChatSignInHostWords(block.text, failure, agentName)
    const signInDetail =
      hostWords && detail && !hostWords.includes(detail.trim())
        ? `${hostWords}\n\n${detail}`
        : (hostWords ?? detail)
    return (
      <NativeChatTranscriptSignInNotice
        agentName={agentName}
        account={failure.account}
        rowId={messageId}
        fallback={row}
        details={
          block.providerFrame || signInDetail ? (
            <Details.ProviderFrameRow
              block={block}
              detail={signInDetail}
              summary={t('components.native-chat.notices.details', 'Details')}
            />
          ) : null
        }
      />
    )
  }
  // Only setup failures read the setup context, so other rows skip its changes.
  return isNativeChatSetupFailureKind(block.failure?.kind) ? (
    <NativeChatSetupFailureRow rowId={messageId} row={row} />
  ) : (
    row(false)
  )
}

/** A setup failure a later successful turn resolved reads as history: muted, with no action. */
function NativeChatSetupFailureRow({
  rowId,
  row
}: {
  rowId: string | undefined
  row: (resolved: boolean) => React.JSX.Element
}): React.JSX.Element {
  return row(isNativeChatFailureRowResolved(useNativeChatHostSetupView(), rowId))
}
