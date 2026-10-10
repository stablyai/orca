import { AlertCircle, Loader2, RotateCcw } from 'lucide-react'
import { useNativeChatRestartOfferEnabled } from '../native-chat-restart-offer-gate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  reopenNativeChatRestartOffer,
  useNativeChatRestartOffer,
  useNativeChatRestartRun
} from '../native-chat-resume-on-restart-store'
import { resumeRunInFlight } from '../native-chat-resume-run'
import { resumeRunView } from '../native-chat-resume-run-view'

// Why: closing the resume dialog is a snooze, not a decline — the host keeps the offer. This is
// then the only surface left carrying it, so it is always rendered rather than gated by
// `statusBarItems`. Pressing Resume closes the dialog too, so this entry carries the run while it
// is in flight. It is also the lasting summary of chats the resume could not carry on: its
// toast says so once, and each chat it reached carries its own note.

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
          onClick={() => void reopenNativeChatRestartOffer()}
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

/** Chats answered out of the chats asked, each counted as its own answer arrives. */
function resumingText(done: number, total: number): SegmentText {
  return {
    label: translate(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumingProgressLabel',
      'Resuming chats {{value0}}/{{value1}}',
      { value0: done, value1: total }
    ),
    ariaLabel: translate(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumingProgressAria',
      'Resuming chats, {{value0}} of {{value1}} done. Click to open details.',
      { value0: done, value1: total }
    ),
    tooltip: translate(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumingTooltip',
      'Restoring interrupted chats and asking them to carry on…'
    )
  }
}

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
  const offerEnabled = useNativeChatRestartOfferEnabled()
  const { candidates, failed } = useNativeChatRestartOffer(offerEnabled)
  const run = useNativeChatRestartRun()
  const failureBySession = new Map(failed.map((entry) => [entry.sessionId, entry]))
  const view = run ? resumeRunView(run, candidates, (id) => failureBySession.get(id), 'all') : null
  if (!offerEnabled) {
    return null
  }

  // Count the selection once until the action publishes the host's remaining list.
  const running = run !== null && resumeRunInFlight(run)
  const inRun = new Set(running ? run.entries.map((entry) => entry.candidate.sessionId) : [])
  const waiting = failed.filter((failure) => !inRun.has(failure.sessionId))
  const pending = candidates.filter((candidate) => !inRun.has(candidate.sessionId)).length
  const failures = waiting.length
  // An unconfirmed chat may be working, so "failed" would invite a duplicate "continue".
  const unconfirmed = waiting.some((failure) => failure.outcome === 'unconfirmed')
  return (
    <>
      {running && (
        <Segment
          iconOnly={iconOnly}
          count={view?.counts.total ?? 0}
          icon={<Loader2 className="size-3 animate-spin text-muted-foreground" />}
          {...resumingText(view?.counts.done ?? 0, view?.counts.total ?? 0)}
        />
      )}
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
