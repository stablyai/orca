import { AlertCircle, RotateCcw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { requestNativeChatResumeOnRestartDialog } from '../native-chat-resume-on-restart-dialog'
import {
  refreshNativeChatRestartOffer,
  useNativeChatRestartOffer
} from '../native-chat-resume-on-restart-store'

// Why: closing the resume dialog is a snooze, not a decline — the host keeps the offer. This is
// then the only surface left carrying it, so it is always rendered rather than gated by
// `statusBarItems`. A chat the resume could not carry on is kept the same way: the toast that
// reported it is gone in seconds, and this entry is what still names it.

/** Re-reads the host before opening so the dialog always reflects the current durable records.
 *  Opening the chat itself is read-only and does not retire the offer. */
async function reopenOffer(): Promise<void> {
  const { candidates, failed } = await refreshNativeChatRestartOffer()
  if (candidates.length > 0 || failed.length > 0) {
    requestNativeChatResumeOnRestartDialog()
  }
}

function Segment({
  icon,
  label,
  ariaLabel,
  tooltip,
  iconOnly,
  count
}: {
  icon: React.ReactNode
  label: string
  ariaLabel: string
  tooltip: string
  iconOnly: boolean
  count: number
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void reopenOffer()}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={ariaLabel}
        >
          {icon}
          <span className="text-[11px]">{iconOnly ? count : label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

type SegmentText = { label: string; ariaLabel: string; tooltip: string }

function failedText(count: number): SegmentText {
  return {
    label:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.failedLabelOne',
            '1 chat failed to resume'
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.failedLabel',
            '{{value0}} chats failed to resume',
            { value0: count }
          ),
    ariaLabel:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.failedAriaOne',
            '1 chat failed to resume. Click for details.'
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.failedAria',
            '{{value0}} chats failed to resume. Click for details.',
            { value0: count }
          ),
    tooltip: translate(
      'auto.components.status.bar.NativeChatResumeStatusSegment.failedTooltip',
      'Chats Orca could not resume after the restart. Click for details.'
    )
  }
}

/** True of a refused chat and an unconfirmed one alike, for a list holding either. */
function checkText(count: number): SegmentText {
  return {
    label:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.checkLabelOne',
            '1 chat to check'
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.checkLabel',
            '{{value0}} chats to check',
            { value0: count }
          ),
    ariaLabel:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.checkAriaOne',
            '1 chat to check after resuming. Click for details.'
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.checkAria',
            '{{value0}} chats to check after resuming. Click for details.',
            { value0: count }
          ),
    tooltip: translate(
      'auto.components.status.bar.NativeChatResumeStatusSegment.checkTooltip',
      'Chats Orca couldn’t resume, or couldn’t confirm it resumed, after the restart. Click for details.'
    )
  }
}

export function NativeChatResumeStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const structuredEnabled = useAppStore(
    (store) => store.settings?.experimentalStructuredNativeChat === true
  )
  const { candidates, failed } = useNativeChatRestartOffer(structuredEnabled)
  if (!structuredEnabled || (candidates.length === 0 && failed.length === 0)) {
    return null
  }

  const pending = candidates.length
  const failures = failed.length
  // An unconfirmed chat may be working, so "failed" would invite a duplicate "continue".
  const unconfirmed = failed.some((failure) => failure.outcome === 'unconfirmed')
  return (
    <>
      {pending > 0 && (
        <Segment
          iconOnly={iconOnly}
          count={pending}
          icon={<RotateCcw className="size-3 text-muted-foreground" />}
          label={
            pending === 1
              ? translate(
                  'auto.components.status.bar.NativeChatResumeStatusSegment.labelOne',
                  '1 chat to resume'
                )
              : translate(
                  'auto.components.status.bar.NativeChatResumeStatusSegment.label',
                  '{{value0}} chats to resume',
                  { value0: pending }
                )
          }
          ariaLabel={
            pending === 1
              ? translate(
                  'auto.components.status.bar.NativeChatResumeStatusSegment.ariaLabelOne',
                  '1 chat available to resume'
                )
              : translate(
                  'auto.components.status.bar.NativeChatResumeStatusSegment.ariaLabel',
                  '{{value0}} chats available to resume',
                  { value0: pending }
                )
          }
          tooltip={translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.tooltip',
            'Open interrupted chats available to resume'
          )}
        />
      )}
      {failures > 0 && (
        // A different fact from the offer — the outcome of acting on it — so a second entry, not a
        // merged count. Same yellow the skill-update segment uses for its own failed state.
        <Segment
          iconOnly={iconOnly}
          count={failures}
          icon={<AlertCircle className="size-3 text-status-warning" />}
          {...(unconfirmed ? checkText(failures) : failedText(failures))}
        />
      )}
    </>
  )
}
