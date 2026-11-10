// The composer's side of the setup tracker (A6/X1) and the B2 switch row: what the tracker shows
// while the browser trip is open, and the setup rows with B2's Team row swapped in.
import { useCallback, useMemo, type ReactNode } from 'react'
import { readCloudStartDraft, saveCloudStartDraft } from '@/lib/orca-cloud/cloud-start-draft'
import type { CloudSetupSessionSnapshot } from '@/lib/orca-cloud/cloud-setup-session-seam'
import type {
  CloudSetupStep,
  CloudSetupStepId
} from '@/components/new-workspace/run-on/cloud-start-model'
import { setupActionFor } from '@/components/new-workspace/run-on/cloud-start-actions'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import type { CloudSetupBrowserTrackerProps } from './CloudSetupBrowserTracker'
import {
  applySwitchTeamStep,
  useCloudSetupSwitchTeam,
  type CloudSetupSwitchTeam
} from './CloudSetupSwitchTeam'
import { parseCloudSetupError } from './cloud-setup-errors'
import {
  canCopyCloudSetupLink,
  copyCloudSetupLink,
  reopenCloudSetup
} from './cloud-setup-tracker-actions'

export type CloudSetupTrackerView = Omit<
  CloudSetupBrowserTrackerProps,
  'steps' | 'rowActions' | 'className'
>

/** What the tracker and B2 add to the composer's CloudStartView. */
export type CloudSetupViewExtras = {
  /** Per-row actions in the setup panel (B2's "Switch to <team>"). */
  rowActions?: Partial<Record<CloudSetupStepId, ReactNode>>
  /** While the setup trip is open in the browser: the tracker replaces the panel (A6, X1). */
  tracker?: CloudSetupTrackerView
  /** Start is held (aria-disabled) with this reason, e.g. "Switch to acme first" (B2). */
  primaryHeldReason?: string
}

/** "Cancel setup": the draft keeps its prompt but forgets the trip (finished steps stay done). */
export function clearCloudSetupSessionFromDraft(profileId: string | null): void {
  const draft = readCloudStartDraft(profileId)
  if (draft) {
    saveCloudStartDraft(profileId, { ...draft, setupSessionId: null })
  }
}

/**
 * The tracker's props while a trip from this composer is still waiting in the browser, or stopped
 * on an error; undefined otherwise. Rows derived from billing (no session yet) work too: Reopen then
 * re-runs today's setup action and there is no link to copy.
 */
export function useComposerSetupTracker({
  cloudSelected,
  setupStarted,
  allSet,
  readyToStart,
  session,
  sessionId,
  steps,
  access,
  availability,
  profileId,
  runSetup,
  onCancel
}: {
  cloudSelected: boolean
  setupStarted: boolean
  allSet: boolean
  readyToStart: boolean
  session: CloudSetupSessionSnapshot | null
  sessionId: string | null
  steps: readonly CloudSetupStep[]
  access: OrcaCloudRunTargetAccess
  availability: OrcaCloudAvailability
  profileId: string | null
  /** A fresh setup trip for whatever is still open. */
  runSetup: () => void
  /** Ends the trip in the composer; the draft forgets the session here. */
  onCancel: () => unknown
}): CloudSetupTrackerView | undefined {
  const error = useMemo(() => {
    const parsed = parseCloudSetupError(session?.error)
    return parsed && session?.teamName ? { ...parsed, teamName: session.teamName } : parsed
  }, [session?.error, session?.teamName])
  const open = cloudSelected && setupStarted && !allSet && (!readyToStart || error !== null)
  const rerun = useCallback(
    () => setupActionFor(steps, access, availability)?.(),
    [access, availability, steps]
  )
  const canManageBilling = access.state === 'no-plan' ? access.canManageBilling : true
  return useMemo(() => {
    if (!open) {
      return undefined
    }
    const reopen = (): void => void reopenCloudSetup(sessionId, rerun)
    return {
      error,
      canManageBilling,
      sessionId,
      onCancel: () => {
        onCancel()
        clearCloudSetupSessionFromDraft(profileId)
      },
      ...(sessionId && canCopyCloudSetupLink(sessionId)
        ? { onCopyLink: () => void copyCloudSetupLink(sessionId) }
        : {}),
      onReopen: reopen,
      // A canceled Checkout, a used trial or a failed team: a fresh trip covers what's still open.
      onErrorAction: (action) => (action === 'reopen-browser' ? reopen() : runSetup())
    }
  }, [canManageBilling, error, onCancel, open, profileId, rerun, runSetup, sessionId])
}

/** B2 applied to the setup rows: the rows to show, and the switch when it holds Start. */
export function useSwitchTeamSteps(
  baseSteps: CloudSetupStep[],
  enabled: boolean
): { steps: CloudSetupStep[]; held: CloudSetupSwitchTeam | null } {
  const switchTeam = useCloudSetupSwitchTeam(enabled)
  const teamStep = switchTeam?.step
  const switched = useMemo(
    () => (teamStep ? applySwitchTeamStep(baseSteps, teamStep) : null),
    [baseSteps, teamStep]
  )
  return { steps: switched ?? baseSteps, held: switched ? switchTeam : null }
}

/** The view fields the tracker and B2 add. */
export function setupViewExtras(
  switchTeam: CloudSetupSwitchTeam | null,
  tracker: CloudSetupTrackerView | undefined
): CloudSetupViewExtras {
  return {
    ...(switchTeam
      ? { rowActions: { team: switchTeam.action }, primaryHeldReason: switchTeam.startHeldReason }
      : {}),
    ...(tracker ? { tracker } : {})
  }
}
