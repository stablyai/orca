import { AlertCircle, CheckCircle2, Loader2, RotateCcw } from 'lucide-react'
import { useNativeChatRestartOfferEnabled } from '../native-chat-restart-offer-gate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  localNativeChatRestartStore,
  useNativeChatRestartOffer,
  useNativeChatRestartRun,
  type NativeChatRestartStore
} from '../native-chat-resume-on-restart-store'
import { useNativeChatRestartRuntimes } from '../native-chat-restart-runtimes'
import { resumeRunInFlight } from '../native-chat-resume-run'
import { resumeRunFailures, resumeRunView } from '../native-chat-resume-run-view'

// Keep offers and in-flight/results visible after dialog snooze; statusBarItems must not hide the remaining resume surface.

function Segment({
  icon,
  label,
  ariaLabel,
  tooltip,
  iconOnly,
  count,
  onOpen,
  machineName
}: {
  icon: React.ReactNode
  label: string
  ariaLabel: string
  tooltip: string
  iconOnly: boolean
  count: number
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
          <span className="text-[11px]">
            {iconOnly ? count : machineName ? `${machineName}: ${label}` : label}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {machineName ? `${machineName}: ${tooltip}` : tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

type SegmentText = { label: string; ariaLabel: string; tooltip: string }

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
            'auto.components.status.bar.NativeChatResumeStatusSegment.chatsFailedLabel_one',
            '{{count}} chat failed to resume',
            { count }
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.chatsFailedLabel_other',
            '{{count}} chats failed to resume',
            { count }
          ),
    ariaLabel:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.chatsFailedAria_one',
            '{{count}} chat failed to resume. Click for details.',
            { count }
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.chatsFailedAria_other',
            '{{count}} chats failed to resume. Click for details.',
            { count }
          ),
    tooltip: translate(
      'auto.components.status.bar.NativeChatResumeStatusSegment.failedTooltip',
      'Chats Orca could not resume after the restart. Click for details.'
    )
  }
}

function resumedText(count: number): SegmentText {
  return {
    label:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.resumedLabelCount_one',
            '{{count}} chat resumed',
            { count }
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.resumedLabelCount_other',
            '{{count}} chats resumed',
            { count }
          ),
    ariaLabel:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.resumedAriaCount_one',
            '{{count}} chat resumed. Click to see it.',
            { count }
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.resumedAriaCount_other',
            '{{count}} chats resumed. Click to see them.',
            { count }
          ),
    tooltip: translate(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumedTooltip',
      'Chats Orca resumed after the restart. Click to see them.'
    )
  }
}

function checkText(count: number): SegmentText {
  return {
    label:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.checkLabelCount_one',
            '{{count}} chat to check',
            { count }
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.checkLabelCount_other',
            '{{count}} chats to check',
            { count }
          ),
    ariaLabel:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.checkAriaCount_one',
            '{{count}} chat to check after resuming. Click for details.',
            { count }
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.checkAriaCount_other',
            '{{count}} chats to check after resuming. Click for details.',
            { count }
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
}): React.JSX.Element {
  const enabled = useNativeChatRestartOfferEnabled()
  const runtimes = useNativeChatRestartRuntimes()
  return (
    <>
      <NativeChatRuntimeResumeStatusSegment
        iconOnly={iconOnly}
        store={localNativeChatRestartStore}
        offerEnabled={enabled}
      />
      {runtimes.map(({ environment, store }) => (
        <NativeChatRuntimeResumeStatusSegment
          key={environment.id}
          iconOnly={iconOnly}
          store={store}
          machineName={environment.name}
          offerEnabled
        />
      ))}
    </>
  )
}

function NativeChatRuntimeResumeStatusSegment({
  iconOnly,
  store,
  machineName,
  offerEnabled
}: {
  iconOnly: boolean
  store: NativeChatRestartStore
  machineName?: string
  offerEnabled: boolean
}): React.JSX.Element | null {
  const { candidates, failed } = useNativeChatRestartOffer(offerEnabled, store)
  const run = useNativeChatRestartRun(store)
  const failureBySession = resumeRunFailures(run, failed)
  const view = run ? resumeRunView(run, candidates, (id) => failureBySession.get(id), 'all') : null
  if (!offerEnabled) {
    return null
  }

  // Count the selection once until the action publishes the host's remaining list.
  const running = run !== null && resumeRunInFlight(run)
  const inRun = new Set(running ? run.entries.map((entry) => entry.candidate.sessionId) : [])
  const waiting = [...failureBySession.values()].filter((failure) => !inRun.has(failure.sessionId))
  const pending = candidates.filter((candidate) => !inRun.has(candidate.sessionId)).length
  const failures = waiting.length
  // An unconfirmed chat may be working, so "failed" would invite a duplicate "continue".
  const unconfirmed = waiting.some((failure) => failure.outcome === 'unconfirmed')
  // Only this run's own completed rows establish its success; older host failures are separate.
  const resumed =
    run !== null &&
    !running &&
    !run.finishedViewShown &&
    view?.counts.resumed === run.entries.length
      ? (view?.counts.resumed ?? 0)
      : 0
  return (
    <>
      {running && (
        <Segment
          onOpen={store.reopenNativeChatRestartOffer}
          machineName={machineName}
          iconOnly={iconOnly}
          count={view?.counts.total ?? 0}
          icon={<Loader2 className="size-3 animate-spin text-muted-foreground" />}
          {...resumingText(view?.counts.done ?? 0, view?.counts.total ?? 0)}
        />
      )}
      {pending > 0 && (
        <Segment
          onOpen={store.reopenNativeChatRestartOffer}
          machineName={machineName}
          iconOnly={iconOnly}
          count={pending}
          icon={<RotateCcw className="size-3 text-muted-foreground" />}
          label={
            pending === 1
              ? translate(
                  'auto.components.status.bar.NativeChatResumeStatusSegment.labelCount_one',
                  '{{count}} chat to resume',
                  { count: pending }
                )
              : translate(
                  'auto.components.status.bar.NativeChatResumeStatusSegment.labelCount_other',
                  '{{count}} chats to resume',
                  { count: pending }
                )
          }
          ariaLabel={
            pending === 1
              ? translate(
                  'auto.components.status.bar.NativeChatResumeStatusSegment.ariaLabelCount_one',
                  '{{count}} chat available to resume',
                  { count: pending }
                )
              : translate(
                  'auto.components.status.bar.NativeChatResumeStatusSegment.ariaLabelCount_other',
                  '{{count}} chats available to resume',
                  { count: pending }
                )
          }
          tooltip={translate(
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
          iconOnly={iconOnly}
          count={failures}
          icon={<AlertCircle className="size-3 text-status-warning" />}
          {...(unconfirmed ? checkText(failures) : failedText(failures))}
        />
      )}
      {resumed > 0 && (
        <Segment
          onOpen={store.reopenNativeChatRestartOffer}
          machineName={machineName}
          iconOnly={iconOnly}
          count={resumed}
          icon={<CheckCircle2 className="size-3 text-status-success" />}
          {...resumedText(resumed)}
        />
      )}
    </>
  )
}
