import { AlertCircle, RotateCcw } from 'lucide-react'
import { useLocalStructuredChatsInUse } from '../../runtime/native-chat/local-sessions/local-structured-chats'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  localNativeChatRestartStore,
  useNativeChatRestartOffer,
  useNativeChatRestartResuming
} from '../native-chat-recovery/offers/native-chat-resume-on-restart-store'
import type { NativeChatRestartStore } from '../native-chat-recovery/offers/native-chat-restart-runtime-store'
import { useNativeChatRestartRuntimes } from '../native-chat-recovery/offers/native-chat-restart-runtimes'
// Keep offers and failures visible after dialog snooze; statusBarItems must not hide the remaining resume surface.
// A resumed chat shows its own progress, so nothing here follows a resume.

function Segment({
  icon,
  label,
  ariaLabel,
  tooltip,
  onOpen,
  machineName
}: {
  icon: React.ReactNode
  label: string
  ariaLabel: string
  tooltip: string
  onOpen: () => Promise<void>
  machineName?: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void onOpen()}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={machineName ? `${machineName}: ${ariaLabel}` : ariaLabel}
        >
          {icon}
          <span className="text-[11px]">{machineName ? `${machineName}: ${label}` : label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {machineName ? `${machineName}: ${tooltip}` : tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

type SegmentText = { label: string; ariaLabel: string; tooltip: string }

function failedText(count: number, t: Translate = translate): SegmentText {
  return {
    label: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.chatsFailedLabel',
      '{{count}} chats failed to resume',
      { count, defaultValue_one: '{{count}} chat failed to resume' }
    ),
    ariaLabel: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.chatsFailedAria',
      '{{count}} chats failed to resume. Click for details.',
      { count, defaultValue_one: '{{count}} chat failed to resume. Click for details.' }
    ),
    tooltip: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.failedTooltip',
      'Chats Orca could not resume after the restart. Click for details.'
    )
  }
}

function checkText(count: number, t: Translate = translate): SegmentText {
  return {
    label: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.checkLabelCount',
      '{{count}} chats to check',
      { count, defaultValue_one: '{{count}} chat to check' }
    ),
    ariaLabel: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.checkAriaCount',
      '{{count}} chats to check after resuming. Click for details.',
      { count, defaultValue_one: '{{count}} chat to check after resuming. Click for details.' }
    ),
    tooltip: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.checkTooltip',
      'Chats Orca couldn’t resume, or couldn’t confirm it resumed, after the restart. Click for details.'
    )
  }
}

export function NativeChatResumeStatusSegment(): React.JSX.Element {
  const enabled = useLocalStructuredChatsInUse()
  const runtimes = useNativeChatRestartRuntimes()
  return (
    <>
      <NativeChatRuntimeResumeStatusSegment
        store={localNativeChatRestartStore}
        offerEnabled={enabled}
      />
      {runtimes.map(({ environment, store }) => (
        <NativeChatRuntimeResumeStatusSegment
          key={environment.id}
          store={store}
          machineName={environment.name}
          offerEnabled
        />
      ))}
    </>
  )
}

function NativeChatRuntimeResumeStatusSegment({
  store,
  machineName,
  offerEnabled
}: {
  store: NativeChatRestartStore
  machineName?: string
  offerEnabled: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const { candidates, failed } = useNativeChatRestartOffer(offerEnabled, store)
  const resuming = useNativeChatRestartResuming(store)
  if (!offerEnabled) {
    return null
  }
  // Chats being handed over show their own progress; they leave the count at once.
  const handing = new Set(resuming)
  const pending = candidates.filter((candidate) => !handing.has(candidate.sessionId)).length
  const waiting = failed.filter((failure) => !handing.has(failure.sessionId))
  const failures = waiting.length
  // An unconfirmed chat may be working, so "failed" would invite a duplicate "continue".
  const unconfirmed = waiting.some((failure) => failure.outcome === 'unconfirmed')
  return (
    <>
      {pending > 0 && (
        <Segment
          onOpen={store.reopenNativeChatRestartOffer}
          machineName={machineName}
          icon={<RotateCcw className="size-3 text-muted-foreground" />}
          label={t(
            'auto.components.status.bar.NativeChatResumeStatusSegment.labelCount',
            '{{count}} chats to resume',
            { count: pending, defaultValue_one: '{{count}} chat to resume' }
          )}
          ariaLabel={t(
            'auto.components.status.bar.NativeChatResumeStatusSegment.ariaLabelCount',
            '{{count}} chats available to resume',
            { count: pending, defaultValue_one: '{{count}} chat available to resume' }
          )}
          tooltip={t(
            'auto.components.status.bar.NativeChatResumeStatusSegment.tooltip',
            'Open interrupted chats available to resume'
          )}
        />
      )}
      {failures > 0 && (
        // Report failed outcomes separately from the remaining offer, using the shared failure-warning tone.
        <Segment
          onOpen={store.reopenNativeChatRestartOffer}
          machineName={machineName}
          icon={<AlertCircle className="size-3 text-status-warning" />}
          {...(unconfirmed ? checkText(failures, t) : failedText(failures, t))}
        />
      )}
    </>
  )
}
