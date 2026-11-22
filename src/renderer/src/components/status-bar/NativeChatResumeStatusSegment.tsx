import { AlertCircle, CheckCircle2, Loader2, RotateCcw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  localNativeChatRestartStore,
  useNativeChatRestartOffer,
  useNativeChatRestartRun,
  useLocalRestartOffersEnabled
} from '../native-chat-recovery/offers/native-chat-resume-on-restart-store'
import type { NativeChatRestartStore } from '../native-chat-recovery/offers/native-chat-restart-runtime-store'
import { useNativeChatRestartRuntimes } from '../native-chat-recovery/offers/native-chat-restart-runtimes'
import { resumeRunInFlight } from '../native-chat-recovery/runs/native-chat-resume-run'
import {
  resumeRunFailures,
  resumeRunView
} from '../native-chat-recovery/runs/native-chat-resume-run-view'

// Keep offers and in-flight/results visible after dialog snooze; statusBarItems must not hide the remaining resume surface.

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

function resumingText(done: number, total: number, t: Translate = translate): SegmentText {
  return {
    label: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumingProgressLabel',
      'Resuming agents {{value0}}/{{value1}}',
      { value0: done, value1: total }
    ),
    ariaLabel: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumingProgressAria',
      'Resuming agents, {{value0}} of {{value1}} done. Click to open details.',
      { value0: done, value1: total }
    ),
    tooltip: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumingTooltip',
      'Restoring interrupted agents and asking them to carry on…'
    )
  }
}

function failedText(count: number, t: Translate = translate): SegmentText {
  return {
    label: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.chatsFailedLabel',
      '{{count}} agents failed to resume',
      { count, defaultValue_one: '{{count}} agent failed to resume' }
    ),
    ariaLabel: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.chatsFailedAria',
      '{{count}} agents failed to resume. Click for details.',
      { count, defaultValue_one: '{{count}} agent failed to resume. Click for details.' }
    ),
    tooltip: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.failedTooltip',
      'Agents Orca could not resume after the restart. Click for details.'
    )
  }
}

function resumedText(count: number, t: Translate = translate): SegmentText {
  return {
    label: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumedLabelCount',
      '{{count}} agents resumed',
      { count, defaultValue_one: '{{count}} agent resumed' }
    ),
    ariaLabel: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumedAriaCount',
      '{{count}} agents resumed. Click to see them.',
      { count, defaultValue_one: '{{count}} agent resumed. Click to see it.' }
    ),
    tooltip: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumedTooltip',
      'Agents Orca resumed after the restart. Click to see them.'
    )
  }
}

function checkText(count: number, t: Translate = translate): SegmentText {
  return {
    label: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.checkLabelCount',
      '{{count}} agents to check',
      { count, defaultValue_one: '{{count}} agent to check' }
    ),
    ariaLabel: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.checkAriaCount',
      '{{count}} agents to check after resuming. Click for details.',
      { count, defaultValue_one: '{{count}} agent to check after resuming. Click for details.' }
    ),
    tooltip: t(
      'auto.components.status.bar.NativeChatResumeStatusSegment.checkTooltip',
      'Agents Orca couldn’t resume, or couldn’t confirm it resumed, after the restart. Click for details.'
    )
  }
}

export function NativeChatResumeStatusSegment(): React.JSX.Element {
  const enabled = useLocalRestartOffersEnabled()
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
          icon={<Loader2 className="size-3 animate-spin text-muted-foreground" />}
          {...resumingText(view?.counts.done ?? 0, view?.counts.total ?? 0, t)}
        />
      )}
      {pending > 0 && (
        <Segment
          onOpen={store.reopenNativeChatRestartOffer}
          machineName={machineName}
          icon={<RotateCcw className="size-3 text-muted-foreground" />}
          label={t(
            'auto.components.status.bar.NativeChatResumeStatusSegment.labelCount',
            '{{count}} agents to resume',
            { count: pending, defaultValue_one: '{{count}} agent to resume' }
          )}
          ariaLabel={t(
            'auto.components.status.bar.NativeChatResumeStatusSegment.ariaLabelCount',
            '{{count}} agents available to resume',
            { count: pending, defaultValue_one: '{{count}} agent available to resume' }
          )}
          tooltip={t(
            'auto.components.status.bar.NativeChatResumeStatusSegment.tooltip',
            'Open interrupted agents available to resume'
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
      {resumed > 0 && (
        <Segment
          onOpen={store.reopenNativeChatRestartOffer}
          machineName={machineName}
          icon={<CheckCircle2 className="size-3 text-status-success" />}
          {...resumedText(resumed, t)}
        />
      )}
    </>
  )
}
