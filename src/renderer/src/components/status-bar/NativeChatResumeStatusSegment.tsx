import { AlertCircle, Loader2, RotateCcw } from 'lucide-react'
import { useNativeChatRestartOfferEnabled } from '../native-chat-restart-offer-gate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  checkText,
  failedText,
  nativeChatResumePendingText,
  resumingText
} from './native-chat-resume-status-text'
import { useNativeChatRestartOffers } from '../native-chat-resume-on-restart-store'
import { useNativeChatRestartRuns } from '../native-chat-restart-runs'
import { resumeRunInFlight } from '../native-chat-resume-run'
import { resumeRunView } from '../native-chat-resume-run-view'
import { reopenNativeChatRestartOffer } from '../native-chat-restart-offer-reopen'
import { useNativeChatRestartOfferSources } from '../native-chat-restart-offer-triggers'
import { LOCAL_RESTART_MACHINE, type RestartMachineKey } from '../native-chat-restart-machines'
import { restartMachineNameFromState } from '../native-chat-restart-machine-name'
import { useAppStore } from '../../store'
import type { ResumeCandidate } from '../native-chat-resume-on-restart-grouping'
import { resumeCandidateOwnership } from '../native-chat-resume-ownership'

// Why: closing the resume dialog is a snooze, not a decline — each host keeps its offer. This is
// then the only surface left carrying it, so it is always rendered rather than gated by
// `statusBarItems`. Pressing Resume closes the dialog too, so this entry carries the run while it
// is in flight. It is also the lasting summary of the user's own chats a resume could not carry
// on: its toast says so once, and each chat it reached carries its own note.
//
// ONE entry across every machine: the dialog covers them all. It counts only the user's own chats
// (another device's or an automation's are listed in the dialog, not counted here), names the
// machine only when there is just one, and its tooltip breaks the count down by machine.

function Segment({
  icon,
  label,
  ariaLabel,
  tooltip,
  iconOnly,
  count,
  machines
}: {
  icon: React.ReactNode
  label: string
  ariaLabel: string
  tooltip: string
  iconOnly: boolean
  count: number
  machines: readonly RestartMachineKey[]
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void reopenNativeChatRestartOffer(machines)}
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

export function NativeChatResumeStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const localEnabled = useNativeChatRestartOfferEnabled()
  useNativeChatRestartOfferSources(localEnabled)
  const offers = useNativeChatRestartOffers()
  const runs = useNativeChatRestartRuns()
  const machines = [...offers.keys()]
  // Joined so the selector returns a primitive and re-renders only when a name changes.
  const names = useAppStore((state) =>
    machines.map((machine) => restartMachineNameFromState(state, machine)).join('\u0000')
  ).split('\u0000')
  const nameByMachine = new Map(machines.map((machine, index) => [machine, names[index]]))
  // Chats answered out of the chats asked, across every machine resuming right now.
  let resumingDone = 0
  let resumingTotal = 0
  const resumingMachines: RestartMachineKey[] = []
  for (const [machine, { run }] of runs) {
    if (!resumeRunInFlight(run)) {
      continue
    }
    const offer = offers.get(machine)
    const failureById = new Map(offer?.failed.map((failure) => [failure.sessionId, failure]))
    const { counts } = resumeRunView(
      run,
      offer?.candidates ?? [],
      (sessionId) => failureById.get(sessionId),
      'all'
    )
    resumingDone += counts.done
    resumingTotal += counts.total
    resumingMachines.push(machine)
  }
  let pending = 0
  let failures = 0
  let unconfirmed = false
  const breakdown: { machine: RestartMachineKey; count: number; name: string }[] = []
  const failingMachines: RestartMachineKey[] = []
  for (const [machine, offer] of offers) {
    // A chat being resumed is counted once, as in flight, until the host answers for it. Only the
    // user's own chats count: another device's or an automation's are theirs to resume.
    const run = runs.get(machine)?.run
    const inFlight = new Set(
      run && resumeRunInFlight(run) ? run.entries.map((entry) => entry.candidate.sessionId) : []
    )
    const counted = (row: ResumeCandidate): boolean =>
      !inFlight.has(row.sessionId) && resumeCandidateOwnership(row) === 'own'
    const waiting = offer.failed.filter(counted)
    const machinePending = offer.candidates.filter(counted).length
    pending += machinePending
    failures += waiting.length
    if (waiting.length > 0) {
      failingMachines.push(machine)
    }
    // An unconfirmed chat may be working, so "failed" would invite a duplicate "continue".
    unconfirmed ||= waiting.some((failure) => failure.outcome === 'unconfirmed')
    if (machinePending > 0) {
      breakdown.push({
        machine,
        count: machinePending,
        name: nameByMachine.get(machine) ?? machine
      })
    }
  }
  const onlyPairedName =
    breakdown.length === 1 && breakdown[0]!.machine !== LOCAL_RESTART_MACHINE
      ? breakdown[0]!.name
      : null
  return (
    <>
      {resumingMachines.length > 0 && (
        <Segment
          iconOnly={iconOnly}
          count={resumingTotal}
          machines={resumingMachines}
          icon={<Loader2 className="size-3 animate-spin text-muted-foreground" />}
          {...resumingText(resumingDone, resumingTotal)}
        />
      )}
      {pending > 0 && (
        <Segment
          iconOnly={iconOnly}
          count={pending}
          machines={breakdown.map((entry) => entry.machine)}
          icon={<RotateCcw className="size-3 text-muted-foreground" />}
          {...nativeChatResumePendingText(pending, onlyPairedName, breakdown)}
        />
      )}
      {failures > 0 && (
        // A different fact from the offer — the outcome of acting on it — so a second entry, not a
        // merged count. Same yellow the skill-update segment uses for its own failed state.
        <Segment
          iconOnly={iconOnly}
          count={failures}
          machines={failingMachines}
          icon={<AlertCircle className="size-3 text-status-warning" />}
          {...(unconfirmed ? checkText(failures) : failedText(failures))}
        />
      )}
    </>
  )
}
